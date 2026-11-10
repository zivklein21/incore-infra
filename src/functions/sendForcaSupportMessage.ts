import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { deriveMemberName } from '../lib/entities';
import { forcaChatAccess, messageSk } from '../lib/forcaChat/access';
import { getThread, notifyChat, resolveChatCaller, touchThread } from '../lib/forcaChat/store';

// POST /sendForcaSupportMessage
// Body: { inquiryId, text }
// Auth: Cognito JWT. The thread's owner, its recipient (the admin, or its
// coach), or an admin on a coach thread (the app shows that read-only; the
// server still accepts it for the Backoffice build in the stores). The sender
// is derived here, never trusted from the client. See lib/forcaChat/access.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { inquiryId?: unknown; text?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const inquiryId = typeof body.inquiryId === 'string' ? body.inquiryId.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!inquiryId || !text) return json(400, { error: 'missing_fields' });

  const [thread, caller] = await Promise.all([getThread(inquiryId), resolveChatCaller(callerUid)]);
  if (!thread) return json(404, { error: 'inquiry_not_found' });
  const access = forcaChatAccess(thread, caller);
  if (!access?.canPost) return json(403, { error: 'forbidden' });

  const nowIso = new Date().toISOString();
  const senderName = caller.profile && !caller.isAdmin ? deriveMemberName(caller.profile) : undefined;
  await Promise.all([
    ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: {
        PK: thread.PK, SK: messageSk(nowIso, randomUUID()), text, sender: access.sender,
        senderUid: callerUid, ...(senderName ? { senderName } : {}), createdAt: nowIso,
      },
    })),
    touchThread(thread, { text, atIso: nowIso, sender: access.sender, side: access.side }),
  ]);

  await notifyChat(thread, access.sender, text);

  return json(200, { success: true });
}
