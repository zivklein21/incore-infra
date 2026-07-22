import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { pickActive, buildMembershipResponse } from './getMemberMembership';

// GET or POST /getAllMemberMemberships
// Auth: Cognito JWT, caller must be admin
//
// Powers the admin Members list — one membership per row, resolved to the
// same shape getMemberMembership.ts returns for a single member. A full
// Scan (not per-member queries) mirrors getAllMembers.ts's already-accepted
// <=50-user scale tradeoff.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#' },
  }));

  const byMember = new Map<string, any[]>();
  for (const item of res.Items ?? []) {
    const memberId = (item.PK as string).replace('MEMBER#', '');
    const list = byMember.get(memberId);
    if (list) list.push(item); else byMember.set(memberId, [item]);
  }

  const result: Record<string, unknown> = {};
  await Promise.all(Array.from(byMember.entries()).map(async ([memberId, items]) => {
    const target = pickActive(items);
    if (target) result[memberId] = await buildMembershipResponse(target);
  }));

  return json(200, { memberships: result });
}
