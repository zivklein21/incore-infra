import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { SupportInquiryItem } from '../lib/entities';

// POST /sendSupportMessage
// Body: { inquiryId, text }
// Auth: Cognito JWT. Caller must own the inquiry or be admin — sender is
// derived server-side from that check, never trusted from the client.
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

  const inquiryKey = { PK: `INQUIRY#${inquiryId}`, SK: 'METADATA' };
  const inquiryRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: inquiryKey }));
  const inquiry = inquiryRes.Item as SupportInquiryItem | undefined;
  if (!inquiry) return json(404, { error: 'inquiry_not_found' });

  const callerIsAdmin = await isAdmin(callerUid);
  if (inquiry.userId !== callerUid && !callerIsAdmin) return json(403, { error: 'forbidden' });
  const sender = callerIsAdmin && inquiry.userId !== callerUid ? 'admin' : 'member';

  const nowIso = new Date().toISOString();
  await Promise.all([
    ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: inquiryKey.PK, SK: `MESSAGE#${randomUUID()}`, text, sender, createdAt: nowIso },
    })),
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: inquiryKey,
      UpdateExpression: 'SET lastMessage = :text, lastMessageAt = :now, lastSender = :sender',
      ExpressionAttributeValues: { ':text': text, ':now': nowIso, ':sender': sender },
    })),
  ]);

  return json(200, { success: true });
}
