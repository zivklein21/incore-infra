import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { FORCA_INQUIRY_GSI2PK, pageInquiries, queryInquiryPartition, scanInquiries } from '../lib/inquiryFeed';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import type { ForcaSupportInquiryItem } from '../lib/entities';

// GET or POST /getCoachForcaInquiries
// Auth: Cognito JWT, caller must be an admin or a coach (getCoachAccess()).
// Unlike getAllForcaInquiries.ts (admin-only, sees everything), this scopes
// to recipientRole === 'coach' inquiries whose pinned groupId is one the
// caller is currently assigned to — deny-by-default for a coach with no
// groups, same as every other coach-gated endpoint. An admin calling this
// (e.g. previewing the coach inbox) sees every coach-addressed inquiry,
// same "isAdmin -> groupIds: 'all'" shape getCoachAccess() already gives.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access) return json(403, { error: 'forbidden' });

  const qs = event.queryStringParameters ?? {};
  const paged = qs.paged === '1' || qs.paged === 'true';
  // Paged (app 1.5.2+): one GSI2 partition instead of a whole-table Scan.
  const items = paged
    ? await queryInquiryPartition<ForcaSupportInquiryItem>(FORCA_TABLE_NAME, FORCA_INQUIRY_GSI2PK)
    : await scanInquiries<ForcaSupportInquiryItem>(FORCA_TABLE_NAME, 'FORCAINQUIRY#');

  const inquiries = items
    .filter((i) => i.recipientRole === 'coach')
    .filter((i) => groupInAccess(access, i.groupId))
    .map((i) => ({
      id: i.PK.replace('FORCAINQUIRY#', ''),
      userId: i.userId ?? '',
      userDisplayName: i.userDisplayName ?? '',
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
