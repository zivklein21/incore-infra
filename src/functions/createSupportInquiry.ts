import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// POST /createSupportInquiry
// Body: { subject, message, userDisplayName, userEmail, autoReply }
// Auth: Cognito JWT (any signed-in member)
//
// Mirrors NewInquiryForm's 3-write sequence: create the inquiry, the
// member's opening message, and an immediate admin-sender auto-reply
// (isAutoReply so onSupportMessageCreated.ts's push trigger skips it) — the
// inquiry's lastMessage ends up showing the auto-reply text while
// lastSender stays 'member' so the admin still sees it as unread.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { subject?: unknown; message?: unknown; userDisplayName?: unknown; userEmail?: unknown; autoReply?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const userDisplayName = typeof body.userDisplayName === 'string' ? body.userDisplayName : '';
  const userEmail = typeof body.userEmail === 'string' ? body.userEmail : '';
  const autoReply = typeof body.autoReply === 'string' ? body.autoReply : '';
  if (!subject || message.length < 10) return json(400, { error: 'invalid_fields' });

  const inquiryId = randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const replyIso = new Date(now.getTime() + 1).toISOString();
  const inquiryKey = { PK: `INQUIRY#${inquiryId}`, SK: 'METADATA' };

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: {
            ...inquiryKey,
            GSI1PK: `MEMBER#${uid}`,
            GSI1SK: `INQUIRY#${nowIso}#${inquiryId}`,
            userId: uid,
            userDisplayName,
            userEmail,
            subject,
            status: 'OPEN',
            lastMessage: autoReply || message,
            lastMessageAt: autoReply ? replyIso : nowIso,
            lastSender: 'member',
            createdAt: nowIso,
          },
        },
      },
      {
        Put: {
          TableName: TABLE_NAME,
          Item: { PK: inquiryKey.PK, SK: `MESSAGE#${randomUUID()}`, text: message, sender: 'member', createdAt: nowIso },
        },
      },
      ...(autoReply ? [{
        Put: {
          TableName: TABLE_NAME,
          Item: { PK: inquiryKey.PK, SK: `MESSAGE#${randomUUID()}`, text: autoReply, sender: 'admin', createdAt: replyIso, isAutoReply: true },
        },
      }] : []),
    ],
  }));

  return json(200, { success: true, inquiryId });
}
