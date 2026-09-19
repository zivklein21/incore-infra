import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMemberProfile } from '../lib/memberLookup';

// POST /updatePushToken
// Body: { token: string }
// Auth: Cognito JWT (any signed-in member)
//
// Was hardcoded to TABLE_NAME (incore) only — silently 404'd for every
// FORCA coach/trainee/parent (their profiles live in FORCA_TABLE_NAME), so
// a coach's device never actually saved a push token even after this
// endpoint got called, which meant declareAttendance.ts's "alert the
// session's coach" push (see its notifyDecline()) had no token to send to.
// resolveMemberProfile() checks both tables, same dual-table pattern every
// other "I only have a uid" endpoint here uses.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { token?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return json(400, { error: 'missing_token' });

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const device = { ...(profile.device ?? {}), expo_push_token: token };

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET device = :device',
    ExpressionAttributeValues: { ':device': device },
  }));

  return json(200, { success: true });
}
