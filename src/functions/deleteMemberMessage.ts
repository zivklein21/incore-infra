import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// POST /deleteMemberMessage
// Body: { messageId }
// Auth: Cognito JWT (own messages only)
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { messageId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
  if (!messageId) return json(400, { error: 'missing_message_id' });

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: `MESSAGE#${messageId}` } }));
  return json(200, { success: true });
}
