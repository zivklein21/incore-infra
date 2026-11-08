import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { CancellationItem, ClassItem, MembershipItem } from '../lib/entities';
import { decodeRowCursor, windowRows } from '../lib/datePaging';

// GET or POST /getMemberCancellations?memberId=xxx[&paged=1&cursor=…]
// Auth: Cognito JWT, caller must be admin
//
// V2-only — the old Firestore version also read a legacy member.classes.
// cancellations array (pre-V2 model); nothing in the DynamoDB migration
// carries that shape forward, so there is no legacy branch here.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const memberId = event.queryStringParameters?.memberId;
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const qs = event.queryStringParameters ?? {};
  const paged = qs.paged === '1' || qs.paged === 'true';
  const cursor = paged && qs.cursor ? decodeRowCursor(qs.cursor) : null;
  if (paged && qs.cursor && !cursor) return json(400, { error: 'invalid_cursor' });

  const all: CancellationItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'CANCEL#' },
      ExclusiveStartKey: lastKey,
    }));
    all.push(...((res.Items ?? []) as CancellationItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  // ?paged=1: the last 2 months by cancellation time, then 2 more per Load
  // more. The SK is CANCEL#<classId>, which doesn't sort by date, so this
  // windows in memory (one member holds a few dozen at most). Classes and
  // memberships are only read for the rows being returned.
  const page = paged
    ? windowRows(all.map((c) => ({ c, date: c.cancelledAt || '1970-01-01T00:00:00.000Z', id: c.classId })), cursor)
    : null;
  const cancellations = page ? page.items.map((x) => x.c) : all;

  const classIds = Array.from(new Set(cancellations.map((c) => c.classId)));
  const membershipKeys = Array.from(new Set(
    cancellations
      .filter((c) => (c.consumedFrom === 'MEMBERSHIP' || c.consumedFrom === 'FUTURE_SUBSCRIPTION') && c.membershipId)
      .map((c) => `${c.targetMonth}#${c.membershipId}`),
  ));

  const [classItems, membershipItems] = await Promise.all([
    Promise.all(classIds.map((id) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${id}`, SK: 'METADATA' } })))),
    Promise.all(membershipKeys.map((k) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: `MEMBERSHIP#${k}` } })))),
  ]);
  const classById = new Map(classIds.map((id, i) => [id, classItems[i].Item as ClassItem | undefined]));
  const membershipByKey = new Map(membershipKeys.map((k, i) => [k, membershipItems[i].Item as (MembershipItem & { productName?: string }) | undefined]));

  const items = cancellations.map((c) => ({
    classId: c.classId,
    cancelledAt: c.cancelledAt,
    isPenalty: c.status === 'LATE_CANCELLED',
    reason: c.status === 'LATE_CANCELLED' ? 'late_cancellation' : 'within_policy',
    cancellationReason: c.cancellationReason ?? '',
    className: classById.get(c.classId)?.className ?? c.classId,
    source: 'v2' as const,
    consumedFrom: c.consumedFrom,
    membershipProductName: c.membershipId ? membershipByKey.get(`${c.targetMonth}#${c.membershipId}`)?.productName : undefined,
  }));

  return json(200, page ? { items, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom } : { items });
}
