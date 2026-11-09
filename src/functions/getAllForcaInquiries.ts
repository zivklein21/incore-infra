import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { FORCA_INQUIRY_GSI2PK, pageInquiries, queryInquiryPartition, scanInquiries } from '../lib/inquiryFeed';
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

  const qs = event.queryStringParameters ?? {};
  const paged = qs.paged === '1' || qs.paged === 'true';
  // Paged (app 1.5.2+): one GSI2 partition instead of a whole-table Scan.
  const items = paged
    ? await queryInquiryPartition<ForcaSupportInquiryItem>(FORCA_TABLE_NAME, FORCA_INQUIRY_GSI2PK)
    : await scanInquiries<ForcaSupportInquiryItem>(FORCA_TABLE_NAME, 'FORCAINQUIRY#');

  const inquiries = items
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

  if (!paged) return json(200, { inquiries });
  const page = pageInquiries(inquiries, qs.cursor);
  if (!page.ok) return json(400, { error: 'invalid_cursor' });
  return json(200, { inquiries: page.inquiries, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom });
}
