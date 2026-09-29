import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

// POST /deleteMemberMessage
// Body: { messageId }
// Auth: Cognito JWT (own messages only)
// Messages live in whichever table the member's own profile lives in —
// same resolveMemberProfile() dual-table lookup as getMemberMessages.ts's
// own read side (hardcoding TABLE_NAME here silently no-op'd for a FORCA
// member: the delete just missed, and her dismissed notification kept
// reappearing on every poll).
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

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(200, { success: true });

  await ddb.send(new DeleteCommand({ TableName: resolved.table, Key: { PK: `MEMBER#${uid}`, SK: `MESSAGE#${messageId}` } }));
  return json(200, { success: true });
}
