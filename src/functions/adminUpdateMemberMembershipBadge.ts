import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminUpdateMemberMembershipBadge
// Body: { memberId, planId, planName?, status, start?, end? }
// Auth: Cognito JWT, caller must be admin
//
// Writes the legacy display-only membership.* bag on the member's profile
// (plan/status/badge shown as a fallback when no real V2 MembershipItem
// exists yet — see getMemberDetail.ts). Granting an actual usable
// membership goes through adminGrantMembership.ts instead; this only
// changes the label.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    memberId?: unknown; planId?: unknown; planName?: unknown;
    status?: unknown; start?: unknown; end?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
  const status = typeof body.status === 'string' ? body.status : 'active';
  if (!memberId || !planId) return json(400, { error: 'missing_fields', required: ['memberId', 'planId'] });

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const membership: Record<string, unknown> = { ...(profile.membership ?? {}), type: planId, status };
  if (typeof body.planName === 'string') membership.plan = body.planName;
  if (typeof body.start === 'string') membership.start = body.start;
  if (typeof body.end === 'string') membership.end = body.end;

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET membership = :membership',
    ExpressionAttributeValues: { ':membership': membership },
  }));

  return json(200, { success: true });
}
