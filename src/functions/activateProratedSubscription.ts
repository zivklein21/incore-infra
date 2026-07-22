import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { ProductItem, MemberProfileItem } from '../lib/entities';

// POST /activateProratedSubscription
//
// SECURITY NOTE ported as-is from the original: this endpoint has NO
// authentication at all in functions/src/products.ts — not a Cognito JWT,
// not even a shared-secret header. It's meant to be called server-to-server
// after a prorated payment confirms, but as written anyone who knows the
// URL can grant a free prorated subscription to any memberId. Preserved
// exactly per the instruction not to change business logic — flagging this
// for follow-up, e.g. adding a shared-secret check like the HYP callback's
// signature verification.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { memberId?: unknown; productId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });

  let sessionsPerWeek = 2;
  let totalSessions = 8;
  if (productId) {
    const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } }));
    const product = productRes.Item as ProductItem | undefined;
    if (product) {
      if (typeof product.sessions_per_week === 'number') sessionsPerWeek = product.sessions_per_week;
      if (typeof product.sessions === 'number') totalSessions = product.sessions;
    }
  }

  const { start, end } = await applyProratedActivation(memberId, sessionsPerWeek, totalSessions);

  // Mark product inactive so it disappears from the shop; not deleted, so
  // productId references in membership items stay valid for auditing.
  if (productId) {
    const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } }));
    if (productRes.Item) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' },
        UpdateExpression: 'SET active = :false',
        ExpressionAttributeValues: { ':false': false },
      }));
    }
  }

  console.log(`[activateProratedSubscription] member=${memberId} start=${start.toISOString()} end=${end.toISOString()} spw=${sessionsPerWeek} total=${totalSessions} product=${productId || 'n/a'}`);
  return json(200, { success: true, start: start.toISOString(), end: end.toISOString() });
}

async function applyProratedActivation(
  memberId: string,
  sessionsPerWeek: number,
  totalSessions: number,
): Promise<{ start: Date; end: Date }> {
  const now = new Date();

  const dayOfWeek = now.getDay();
  const nextSunday = new Date(now);
  if (dayOfWeek !== 0) nextSunday.setDate(now.getDate() + (7 - dayOfWeek));
  nextSunday.setHours(0, 0, 0, 0);

  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const dayOfLastDay = lastDayOfMonth.getDay();
  const daysToSubtract = dayOfLastDay === 6 ? 0 : (dayOfLastDay + 1) % 7;
  const lastSaturday = new Date(lastDayOfMonth);
  lastSaturday.setDate(lastDayOfMonth.getDate() - daysToSubtract);
  lastSaturday.setHours(23, 59, 59, 999);

  const start = nextSunday > lastSaturday ? now : nextSunday;
  start.setHours(0, 0, 0, 0);

  // Field-level merge (not a blanket overwrite) — matches the original's
  // dot-notation update, which only ever touched these specific keys and
  // left the rest of the membership map untouched.
  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  const existingMembership = { ...(memberRes.Item as MemberProfileItem | undefined)?.membership };
  delete existingMembership.activates_on;

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    UpdateExpression: 'SET membership = :membership',
    ExpressionAttributeValues: {
      ':membership': {
        ...existingMembership,
        status: 'prorated',
        type: 'prorated',
        start: start.toISOString(),
        end: lastSaturday.toISOString(),
        prorated_expires: lastSaturday.toISOString(),
        sessions_per_week: sessionsPerWeek,
        total_sessions_remaining: totalSessions,
      },
    },
  }));

  return { start, end: lastSaturday };
}
