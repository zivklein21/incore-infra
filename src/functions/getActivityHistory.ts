import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { CancellationItem, ClassItem, MembershipItem, RegistrationItem } from '../lib/entities';

// GET or POST /getActivityHistory?memberId=xxx
// Auth: Cognito JWT. Defaults to caller's own history; a different memberId
// requires admin (same pattern as getProfile.ts/getWallet.ts).
//
// Two sources, same as the old Firestore version: past REGISTERED
// registrations (GSI1, MEMBER#<uid>/REG#) and the member's cancellation
// history (native PK, MEMBER#<uid>/CANCEL#) — classId dedupes, cancellation
// wins on conflict. className/consumedFrom are already plain, resolved
// values on DynamoDB items (no class_type/product reference join needed the
// way Firestore required).
function purchaseSource(consumedFrom: string, membershipName?: string): string {
  if (consumedFrom === 'MEMBERSHIP' || consumedFrom === 'FUTURE_SUBSCRIPTION') return membershipName ?? 'מנוי';
  if (consumedFrom === 'EXTRA_PUNCH' || consumedFrom === 'CREDIT') return 'ארנק';
  if (consumedFrom === 'ADMIN_CARD') return 'כרטיסיה';
  return consumedFrom || '—';
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const memberId = event.queryStringParameters?.memberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const [regsRes, cancelsRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'CANCEL#' },
    })),
  ]);

  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  const cancellations = (cancelsRes.Items ?? []) as CancellationItem[];
  const now = new Date();

  const classIds = Array.from(new Set([
    ...registrations.map((r) => r.classId),
    ...cancellations.map((c) => c.classId),
  ]));
  const membershipKeys = Array.from(new Set([
    ...registrations.filter((r) => r.membershipId).map((r) => `${r.targetMonth}#${r.membershipId}`),
    ...cancellations.filter((c) => c.membershipId).map((c) => `${c.targetMonth}#${c.membershipId}`),
  ]));

  const [classItems, membershipItems] = await Promise.all([
    Promise.all(classIds.map((id) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${id}`, SK: 'METADATA' } })))),
    Promise.all(membershipKeys.map((k) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: `MEMBERSHIP#${k}` } })))),
  ]);
  const classById = new Map(classIds.map((id, i) => [id, classItems[i].Item as ClassItem | undefined]));
  const membershipByKey = new Map(membershipKeys.map((k, i) => [k, membershipItems[i].Item as (MembershipItem & { productName?: string }) | undefined]));

  const itemMap = new Map<string, Record<string, unknown>>();

  for (const r of registrations) {
    const cls = classById.get(r.classId);
    const classDate = cls ? new Date(cls.date) : new Date(r.classDate);
    if (classDate >= now) continue; // future bookings belong in the Bookings tab
    const membName = r.membershipId ? membershipByKey.get(`${r.targetMonth}#${r.membershipId}`)?.productName : undefined;
    itemMap.set(r.classId, {
      id: r.classId, classId: r.classId, className: cls?.className ?? r.classId,
      classDate: classDate.toISOString(),
      purchaseSource: purchaseSource(r.consumedFrom, membName),
      status: 'REGISTERED',
    });
  }

  for (const c of cancellations) {
    const cls = classById.get(c.classId);
    const classDate = cls ? new Date(cls.date) : new Date(c.cancelledAt);
    const membName = c.membershipId ? membershipByKey.get(`${c.targetMonth}#${c.membershipId}`)?.productName : undefined;
    const status = c.status === 'LATE_CANCELLED' ? 'LATE_CANCELLED' : c.status === 'ADMIN_CANCELLED' ? 'ADMIN_CANCELLED' : 'LEGALLY_CANCELLED';
    itemMap.set(c.classId, {
      id: c.classId, classId: c.classId, className: cls?.className ?? c.classId,
      classDate: classDate.toISOString(),
      purchaseSource: purchaseSource(c.consumedFrom ?? '', membName),
      status,
      ...(status === 'ADMIN_CANCELLED' ? { refundTo: (c as any).refundTo ?? 'none' } : {}),
    });
  }

  const items = Array.from(itemMap.values()).sort(
    (a, b) => new Date(b.classDate as string).getTime() - new Date(a.classDate as string).getTime(),
  );

  return json(200, { items });
}
