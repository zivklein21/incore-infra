import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';

// POST /updatePushToken
// Body: { token: string }
// Auth: Cognito JWT (any signed-in member)
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

  const key = { PK: `MEMBER#${uid}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const device = { ...(profile.device ?? {}), expo_push_token: token };

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET device = :device',
    ExpressionAttributeValues: { ':device': device },
  }));

  return json(200, { success: true });
}
