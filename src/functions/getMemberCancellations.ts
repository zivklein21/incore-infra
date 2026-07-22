import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { CancellationItem, ClassItem, MembershipItem } from '../lib/entities';

// GET or POST /getMemberCancellations?memberId=xxx
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

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'CANCEL#' },
  }));
  const cancellations = (res.Items ?? []) as CancellationItem[];

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

  return json(200, { items });
}
