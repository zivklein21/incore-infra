import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { isMembershipUsableForClass, type ClassItem, type MembershipItem } from '../lib/entities';

// GET or POST /getActiveMembership?memberId=xxx&classId=yyy
// Auth: Cognito JWT. Defaults to the caller's own membership; a different
// memberId requires admin (e.g. ClassActionSheet's add-member flow checking
// a candidate's membership before deciding whether to deduct a session).
//
// Returns the current usable membership (usage/limits needed for
// client-side "can I book via subscription vs. punch card" UI decisions —
// see useClientClassDetails.ts). bookClass.ts is still the sole source of
// truth for actually enforcing quota; this is display-only. A member can
// rarely end up with more than one ACTIVE membership doc (e.g. leftover
// data from a renewal that didn't close out the prior period) — sorting by
// createdAt desc picks the real current one, matching the old Firestore
// version's orderBy('createdAt','desc').limit(1).
//
// classId is optional — when passed (the booking screen always does), a
// PENDING custom-migration grant whose window already covers that class
// counts as usable too, mirroring bookClass.ts's own eligibility check;
// without it (e.g. ClassActionSheet, which isn't tied to one class) this
// stays strictly ACTIVE-only, same as before.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const memberId = event.queryStringParameters?.memberId || callerUid;
  const classId = event.queryStringParameters?.classId || null;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const [res, classRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#' },
    })),
    classId
      ? ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }))
      : Promise.resolve(null),
  ]);

  const classDate = (classRes?.Item as ClassItem | undefined)?.date ? new Date((classRes!.Item as ClassItem).date) : null;
  const allMemberships = (res.Items ?? []) as (MembershipItem & { createdAt?: string })[];
  const memberships = allMemberships.filter((m) => (
    m.status === 'ACTIVE' ? true : classDate !== null && isMembershipUsableForClass(m, classDate)
  ));
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
