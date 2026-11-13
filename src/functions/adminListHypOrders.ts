import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchGetCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { decodeWindowCursor, queryCountPage } from '../lib/datePaging';
import type { HypOrderItem, MemberProfileItem } from '../lib/entities';

// GET/POST /adminListHypOrders
// Auth: Cognito JWT, caller must be admin
//
// Two modes:
// - Paged (body.paged = true, the All Transactions screen from 1.5.2 on):
//   20 orders per page off GSI2 ORDER (GSI2SK=<createdAtIso>#<orderId>),
//   newest first, with brand / category / search applied here so they cover
//   the full history, not just what's loaded. nextCursor is set only when
//   another matching order exists. Body: { paged, cursor?, brand?,
//   category?: 'all'|'shop'|'membership', search? } → { orders, nextCursor }.
// - Legacy (no `paged`, shipped builds and the dashboard counts): the newest
//   100 orders, unchanged.

type OrderRow = ReturnType<typeof toRow>;
type Category = 'all' | 'shop' | 'membership';

const isShopPurchase = (t: string) => t === 'punch_card' || t === 'single_ticket';
const PAGE_SIZE = 20;

function toRow(o: HypOrderItem, member: MemberProfileItem | undefined) {
  return {
    id: o.orderId,
    memberId: o.userId,
    memberName: member?.identity?.name || member?.name || 'Unknown',
    brand: member?.identity?.brand ?? 'incore',
    productName: o.productName,
    productType: o.productType,
    paymentMethod: o.paymentMethod,
    amount: o.amount,
    status: o.status,
    hypCCode: o.hypCCode ?? null,
    createdAt: o.createdAt ?? null,
    // Present whenever this order is one of several payments (either a
    // HYP-native Tash installment sale charged in one shot, or a single
    // charge out of a subscription/store_installment billing agreement) —
    // lets the admin UI show a breakdown instead of a bare amount that
    // reads like a one-off purchase. See entities.ts HypOrderItem.
    totalPayments: o.totalPayments ?? null,
    amountPerCharge: o.amountPerCharge ?? null,
    totalAmount: o.totalAmount ?? null,
    installmentsCount: o.installmentsCount ?? null,
    installmentAmount: o.installmentAmount ?? null,
  };
}

/** Profiles for the given uids, read in batches and kept in `cache`. */
async function loadMembers(uids: string[], cache: Map<string, MemberProfileItem | undefined>): Promise<void> {
  const missing = [...new Set(uids)].filter((u) => u && !cache.has(u));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    let keys: Record<string, unknown>[] | undefined = chunk.map((u) => ({ PK: `MEMBER#${u}`, SK: 'PROFILE' }));
    for (let attempt = 0; keys && keys.length > 0 && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: keys } } }));
      for (const item of (res.Responses?.[TABLE_NAME] ?? []) as MemberProfileItem[]) {
        cache.set(String(item.PK).replace('MEMBER#', ''), item);
      }
      keys = res.UnprocessedKeys?.[TABLE_NAME]?.Keys as Record<string, unknown>[] | undefined;
      if (keys && keys.length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
    for (const u of chunk) if (!cache.has(u)) cache.set(u, undefined);
  }
}

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  const qs = event.queryStringParameters ?? {};
  if (!event.body) return { ...qs };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return { ...qs, ...(JSON.parse(raw) as Record<string, unknown>) };
  } catch {
    return { ...qs };
  }
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const body = parseBody(event);

  if (body.paged !== true && body.paged !== 'true') {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ORDER' },
      ScanIndexForward: false,
      Limit: 100,
    }));
    const items = (res.Items ?? []) as HypOrderItem[];
    const orders = await Promise.all(items.map(async (o) => {
      const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${o.userId}`, SK: 'PROFILE' } }));
      return toRow(o, memberRes.Item as MemberProfileItem | undefined);
    }));
    return json(200, { orders });
  }

  const brand = body.brand === 'forca' || body.brand === 'incore' ? body.brand : null;
  const category: Category = body.category === 'shop' || body.category === 'membership' ? body.category : 'all';
  const search = typeof body.search === 'string' ? body.search.trim().toLowerCase() : '';
  const cursorRaw = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;
  const cursor = cursorRaw ? decodeWindowCursor(cursorRaw, '') : null;
  if (cursorRaw && !cursor) return json(400, { error: 'invalid_cursor' });

  const members = new Map<string, MemberProfileItem | undefined>();
  const result = await queryCountPage<HypOrderItem & Record<string, unknown>, OrderRow>({
    table: TABLE_NAME,
    indexName: 'GSI2',
    pkName: 'GSI2PK',
    pkValue: 'ORDER',
    skName: 'GSI2SK',
    cursor,
    limit: PAGE_SIZE,
    process: async (items) => {
      await loadMembers(items.map((o) => o.userId), members);
      return items.map((o) => {
        const r = toRow(o, members.get(o.userId));
        if (r.status === 'pending') return null;
        if (brand && r.brand !== brand) return null;
        if (category === 'shop' && !isShopPurchase(r.productType)) return null;
        if (category === 'membership' && isShopPurchase(r.productType)) return null;
        if (search && !r.memberName.toLowerCase().includes(search) && !String(r.productName ?? '').toLowerCase().includes(search)) return null;
        return r;
      });
    },
  });

  return json(200, { orders: result.items, nextCursor: result.nextCursor });
}
