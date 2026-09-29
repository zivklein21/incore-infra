import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
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

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND recipientRole = :coach',
    ExpressionAttributeValues: { ':prefix': 'FORCAINQUIRY#', ':metadata': 'METADATA', ':coach': 'coach' },
  }));

  const inquiries = ((res.Items ?? []) as ForcaSupportInquiryItem[])
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

  return json(200, { inquiries });
}
