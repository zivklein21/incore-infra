import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { forcaChatAccess, messageSk } from '../lib/forcaChat/access';
import { getThread, resolveChatCaller, touchThread } from '../lib/forcaChat/store';

// POST /closeForcaSupportInquiry
// Body: { inquiryId }
// Auth: Cognito JWT — the thread's recipient (the admin, or its coach), or an
// admin on a coach thread (kept for the Backoffice build in the stores).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { inquiryId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const inquiryId = typeof body.inquiryId === 'string' ? body.inquiryId.trim() : '';
  if (!inquiryId) return json(400, { error: 'missing_inquiry_id' });

  const [thread, caller] = await Promise.all([getThread(inquiryId), resolveChatCaller(callerUid)]);
  if (!thread) return json(404, { error: 'inquiry_not_found' });
  if (!forcaChatAccess(thread, caller)?.canClose) return json(403, { error: 'forbidden' });

  const nowIso = new Date().toISOString();
  await Promise.all([
    ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: {
        PK: thread.PK, SK: messageSk(nowIso, randomUUID()),
        text: 'השיחה סומנה כטופלה ✓', messageKey: 'RESOLVED', sender: 'system', createdAt: nowIso,
      },
    })),
    touchThread(thread, { text: 'השיחה טופלה', atIso: nowIso, status: 'CLOSED' }),
  ]);

  return json(200, { success: true });
}
