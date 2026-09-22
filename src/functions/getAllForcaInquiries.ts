import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ForcaSupportInquiryItem } from '../lib/entities';

// GET or POST /getAllForcaInquiries
// Auth: Cognito JWT, caller must be admin
// Admin sees every FORCA inquiry regardless of recipientRole — coach-
// addressed ones included. Full Scan, same <=50-user-scale tradeoff as
// getAllInquiries.ts / other admin list endpoints.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'FORCAINQUIRY#', ':metadata': 'METADATA' },
  }));

  const inquiries = ((res.Items ?? []) as ForcaSupportInquiryItem[])
    .map((i) => ({
      id: i.PK.replace('FORCAINQUIRY#', ''),
      userId: i.userId ?? '',
      userDisplayName: i.userDisplayName ?? '',
      userEmail: i.userEmail ?? '',
      recipientRole: i.recipientRole,
      groupName: i.groupName ?? null,
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
