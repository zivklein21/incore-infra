import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /closeSupportInquiry
// Body: { inquiryId }
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { inquiryId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const inquiryId = typeof body.inquiryId === 'string' ? body.inquiryId.trim() : '';
  if (!inquiryId) return json(400, { error: 'missing_inquiry_id' });

  const inquiryKey = { PK: `INQUIRY#${inquiryId}`, SK: 'METADATA' };
  const nowIso = new Date().toISOString();

  await Promise.all([
    ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: inquiryKey.PK, SK: `MESSAGE#${randomUUID()}`,
        text: 'Admin marked this as resolved ✓', messageKey: 'RESOLVED', sender: 'system', createdAt: nowIso,
      },
    })),
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: inquiryKey,
      UpdateExpression: 'SET #status = :closed, lastMessage = :msg, lastMessageAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':closed': 'CLOSED', ':msg': 'Conversation resolved', ':now': nowIso },
    })),
  ]);

  return json(200, { success: true });
}
