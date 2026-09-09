import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminAssignGroup
// Body: { memberId: string, groupId: string | null } — null clears the assignment
// Auth: Cognito JWT, caller must be admin
// FORCA-only — rejects a memberId that resolves to the incore table, since
// Group assignment (identity.groupId) is meaningless for INCORE members.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; groupId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const groupId = typeof body.groupId === 'string' && body.groupId ? body.groupId : null;

  const resolved = await resolveMemberProfile(memberId);
  if (!resolved) return json(404, { error: 'member_not_found' });
  if (resolved.table !== FORCA_TABLE_NAME) return json(400, { error: 'not_a_forca_member' });

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    UpdateExpression: groupId ? 'SET identity.groupId = :groupId' : 'REMOVE identity.groupId',
    ...(groupId ? { ExpressionAttributeValues: { ':groupId': groupId } } : {}),
  }));

  return json(200, { success: true });
}
