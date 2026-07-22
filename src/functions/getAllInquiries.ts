import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { SupportInquiryItem } from '../lib/entities';

// GET or POST /getAllInquiries
// Auth: Cognito JWT, caller must be admin
// Full Scan — same documented <=50-user-scale tradeoff as other admin list
// endpoints (getAllMembers.ts, getClasses.ts). No AWS WebSocket transport
// exists yet, so the client polls this instead of the old Firestore
// onSnapshot listener.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'INQUIRY#', ':metadata': 'METADATA' },
  }));

  const inquiries = ((res.Items ?? []) as SupportInquiryItem[])
    .map((i) => ({
      id: i.PK.replace('INQUIRY#', ''),
      userId: i.userId ?? '',
      userDisplayName: i.userDisplayName ?? '',
      userEmail: i.userEmail ?? '',
      subject: i.subject ?? '',
      status: i.status,
      lastMessage: i.lastMessage ?? '',
      lastSender: i.lastSender ?? 'member',
      createdAt: i.createdAt ?? null,
      lastMessageAt: i.lastMessageAt ?? null,
    }))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? '').localeCompare(a.lastMessageAt ?? a.createdAt ?? ''));

  return json(200, { inquiries });
}
