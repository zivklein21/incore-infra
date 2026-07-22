import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MembershipItem } from '../lib/entities';

// GET or POST /getActiveMembership?memberId=xxx
// Auth: Cognito JWT. Defaults to the caller's own membership; a different
// memberId requires admin (e.g. ClassActionSheet's add-member flow checking
// a candidate's membership before deciding whether to deduct a session).
//
// Returns the current ACTIVE membership (usage/limits needed for
// client-side "can I book via subscription vs. punch card" UI decisions —
// see useClientClassDetails.ts). bookClass.ts is still the sole source of
// truth for actually enforcing quota; this is display-only. A member can
// rarely end up with more than one ACTIVE membership doc (e.g. leftover
// data from a renewal that didn't close out the prior period) — sorting by
// createdAt desc picks the real current one, matching the old Firestore
// version's orderBy('createdAt','desc').limit(1).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const memberId = event.queryStringParameters?.memberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE' },
  }));

  const memberships = (res.Items ?? []) as (MembershipItem & { createdAt?: string })[];
  if (memberships.length === 0) return json(200, { hasActiveMembership: false });

  memberships.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const m = memberships[0];

  return json(200, {
    hasActiveMembership: true,
    membershipId: m.membershipId,
    weeklyLimit: m.weeklyLimit,
    monthlyLimit: m.monthlyLimit,
    weeklyUsage: m.weeklyUsage ?? {},
    totalMonthlyUsed: m.usage?.totalMonthlyUsed ?? 0,
  });
}
