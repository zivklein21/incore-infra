import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import { decodeWindowCursor, queryDateWindow } from './datePaging';
import type { MerchOrderItem } from './entities';

// One member's merch purchase history — shared by getMyOrders (own),
// getChildOrders (parent, family-link authorized) and getMemberOrders
// (admin). Rows come off GSI1PK=MEMBER#<uid>, GSI1SK=MERCHORDER#<iso>#<orderId>.
//
// ?paged=1 (app 1.5.2+): the last 2 months, then 2 months per Load more
// (lib/datePaging.ts), pending checkouts left out → { orders, nextCursor, coveredFrom }.
// Without it: every order, unchanged, for builds already in the stores.

const SK_PREFIX = 'MERCHORDER#';

function toRow(o: MerchOrderItem) {
  return {
    id: o.orderId,
    status: o.status,
    amount: o.amount,
    items: o.items.map((li) => ({
      productName: li.merchProductName,
      variantLabel: li.merchVariantLabel,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
    })),
    createdAt: o.createdAt,
    refundedAmount: o.refundedAmount ?? null,
    refundedAt: o.refundedAt ?? null,
    deliveryStatus: o.deliveryStatus ?? null,
    deliveredAt: o.deliveredAt ?? null,
  };
}

export type MerchOrderHistoryResult =
  | { ok: true; body: { orders: ReturnType<typeof toRow>[]; nextCursor?: string | null; coveredFrom?: string } }
  | { ok: false; error: 'invalid_cursor' };

export async function merchOrderHistory(
  table: string, uid: string, qs: Record<string, string | undefined>,
): Promise<MerchOrderHistoryResult> {
  if (qs.paged !== '1' && qs.paged !== 'true') {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': SK_PREFIX },
      ScanIndexForward: false,
    }));
    return { ok: true, body: { orders: ((res.Items ?? []) as MerchOrderItem[]).map(toRow) } };
  }

  const cursor = qs.cursor ? decodeWindowCursor(qs.cursor, SK_PREFIX) : null;
  if (qs.cursor && !cursor) return { ok: false, error: 'invalid_cursor' };

  const page = await queryDateWindow<MerchOrderItem & Record<string, unknown>, ReturnType<typeof toRow>>({
    table,
    indexName: 'GSI1',
    pkName: 'GSI1PK',
    pkValue: `MEMBER#${uid}`,
    skName: 'GSI1SK',
    skPrefix: SK_PREFIX,
    cursor,
    process: async (items) => items.filter((o) => o.status !== 'pending').map(toRow),
  });
  return { ok: true, body: { orders: page.items, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom } };
}
