import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import type { ForcaSupportInquiryItem } from '../lib/entities';

// POST /closeForcaSupportInquiry
// Body: { inquiryId }
// Auth: Cognito JWT — admin, or a coach currently assigned to the
// inquiry's group (mirrors closeSupportInquiry.ts's admin-only gate,
// extended to whichever coach the inquiry is actually addressed to).
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

  const inquiryKey = { PK: `FORCAINQUIRY#${inquiryId}`, SK: 'METADATA' };
  const inquiryRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: inquiryKey }));
  const inquiry = inquiryRes.Item as ForcaSupportInquiryItem | undefined;
  if (!inquiry) return json(404, { error: 'inquiry_not_found' });

  const callerIsAdmin = await isAdmin(callerUid);
  if (!callerIsAdmin) {
    const access = await getCoachAccess(callerUid);
    const isAssignedCoach = !!access && !access.isAdmin && inquiry.recipientRole === 'coach' && groupInAccess(access, inquiry.groupId);
    if (!isAssignedCoach) return json(403, { error: 'forbidden' });
  }

  const nowIso = new Date().toISOString();
  await Promise.all([
    ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: {
        PK: inquiryKey.PK, SK: `MESSAGE#${randomUUID()}`,
        text: 'השיחה סומנה כטופלה ✓', messageKey: 'RESOLVED', sender: 'system', createdAt: nowIso,
      },
    })),
    ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: inquiryKey,
      UpdateExpression: 'SET #status = :closed, lastMessage = :msg, lastMessageAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':closed': 'CLOSED', ':msg': 'השיחה טופלה', ':now': nowIso },
    })),
  ]);

  return json(200, { success: true });
}
