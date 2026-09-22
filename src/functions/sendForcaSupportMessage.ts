import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ForcaSupportInquiryItem } from '../lib/entities';
import { notifyForcaInquiryParticipants } from '../lib/forcaSupportInquiries';

// POST /sendForcaSupportMessage
// Body: { inquiryId, text }
// Auth: Cognito JWT. Caller must be the trainee, her linked parent, an
// admin, or a coach currently assigned to the inquiry's (pinned) group —
// sender is derived server-side from that check, never trusted from the
// client, same convention as INCORE's own sendSupportMessage.ts.
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

  const inquiryKey = { PK: `FORCAINQUIRY#${inquiryId}`, SK: 'METADATA' };
  const inquiryRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: inquiryKey }));
  const inquiry = inquiryRes.Item as ForcaSupportInquiryItem | undefined;
  if (!inquiry) return json(404, { error: 'inquiry_not_found' });

  const callerIsAdmin = await isAdmin(callerUid);
  let sender: 'member' | 'admin' | 'coach';

  if (callerIsAdmin) {
    sender = 'admin';
  } else if (inquiry.userId === callerUid) {
    sender = 'member';
  } else {
    const link = await verifyFamilyLink(callerUid, inquiry.userId);
    if (link.ok) {
      sender = 'member';
    } else {
      const access = await getCoachAccess(callerUid);
      if (access && !access.isAdmin && inquiry.recipientRole === 'coach' && groupInAccess(access, inquiry.groupId)) {
        sender = 'coach';
      } else {
        return json(403, { error: 'forbidden' });
      }
    }
  }

  const nowIso = new Date().toISOString();
  await Promise.all([
    ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: { PK: inquiryKey.PK, SK: `MESSAGE#${randomUUID()}`, text, sender, createdAt: nowIso },
    })),
    ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: inquiryKey,
      UpdateExpression: 'SET lastMessage = :text, lastMessageAt = :now, lastSender = :sender',
      ExpressionAttributeValues: { ':text': text, ':now': nowIso, ':sender': sender },
    })),
  ]);

  await notifyForcaInquiryParticipants(inquiry, sender, text);

  return json(200, { success: true });
}
