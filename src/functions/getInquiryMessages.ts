import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { SupportInquiryItem, SupportInquiryMessageItem } from '../lib/entities';

// GET or POST /getInquiryMessages?inquiryId=xxx
// Auth: Cognito JWT. Caller must own the inquiry or be admin.
// No AWS WebSocket transport exists yet, so the client polls this instead
// of the old Firestore onSnapshot listener.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const inquiryId = event.queryStringParameters?.inquiryId;
  if (!inquiryId) return json(400, { error: 'missing_inquiry_id' });

  const inquiryRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `INQUIRY#${inquiryId}`, SK: 'METADATA' } }));
  const inquiry = inquiryRes.Item as SupportInquiryItem | undefined;
  if (!inquiry) return json(404, { error: 'inquiry_not_found' });
  if (inquiry.userId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `INQUIRY#${inquiryId}`, ':prefix': 'MESSAGE#' },
  }));

  const messages = ((res.Items ?? []) as SupportInquiryMessageItem[])
    .map((m) => ({
      id: (m.SK as string).replace('MESSAGE#', ''),
      text: m.text ?? '',
      sender: m.sender ?? 'member',
      messageKey: m.messageKey,
      createdAt: m.createdAt,
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  return json(200, { messages });
}
