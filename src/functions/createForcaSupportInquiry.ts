import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { getMemberFullName } from '../lib/hypOrders';
import { deriveMemberName, type ForcaSupportInquiryItem, type GroupItem, type MemberProfileItem } from '../lib/entities';
import { notifyForcaInquiryParticipants } from '../lib/forcaSupportInquiries';

// POST /createForcaSupportInquiry
// Body: { subject, message, recipientRole: 'admin' | 'coach', childUid? }
// Auth: Cognito JWT (any signed-in FORCA member)
//
// FORCA's own chat — INCORE's createSupportInquiry.ts always goes to one
// fixed admin inbox; here the sender picks a recipient. childUid (FORCA
// Child Switcher): a parent messaging on behalf of a linked daughter, same
// family-link-verified pattern as createMerchPaymentPage.ts. The inquiry
// stays keyed to the daughter either way — see entities.ts's
// ForcaSupportInquiryItem comment.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { subject?: unknown; message?: unknown; recipientRole?: unknown; childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const recipientRole = body.recipientRole === 'admin' || body.recipientRole === 'coach' ? body.recipientRole : '';
  if (!subject || message.length < 5 || !recipientRole) return json(400, { error: 'invalid_fields' });

  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (childUid) {
    const link = await verifyFamilyLink(callerUid, childUid);
    if (!link.ok) return json(403, { error: 'forbidden' });
  }
  const traineeUid = childUid || callerUid;

  const [traineeRes, payerRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${traineeUid}`, SK: 'PROFILE' } })),
    childUid ? ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' } })) : Promise.resolve(null),
  ]);
  const trainee = traineeRes.Item as MemberProfileItem | undefined;
  if (!trainee) return json(404, { error: 'member_not_found' });
  const payer = payerRes?.Item as MemberProfileItem | undefined;
  if (childUid && !payer) return json(404, { error: 'payer_not_found' });

  let groupId: string | undefined;
  let groupName: string | undefined;
  if (recipientRole === 'coach') {
    groupId = trainee.identity?.groupId;
    if (!groupId) return json(400, { error: 'no_group_assigned' });
    const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } }));
    groupName = (groupRes.Item as GroupItem | undefined)?.name;
  }

  const inquiryId = randomUUID();
  const nowIso = new Date().toISOString();
  const inquiryKey = { PK: `FORCAINQUIRY#${inquiryId}`, SK: 'METADATA' };

  const inquiryItem: ForcaSupportInquiryItem = {
    ...inquiryKey,
    GSI1PK: `MEMBER#${traineeUid}`,
    GSI1SK: `FORCAINQUIRY#${nowIso}#${inquiryId}`,
    GSI2PK: 'FORCAINQUIRY',
    GSI2SK: `${nowIso}#${inquiryId}`,
    status: 'OPEN',
    userId: traineeUid,
    userDisplayName: deriveMemberName(trainee),
    userEmail: trainee.identity?.email ?? trainee.email ?? '',
    recipientRole,
    ...(groupId ? { groupId, groupName: groupName ?? '' } : {}),
    subject,
    lastMessage: message,
    lastMessageAt: nowIso,
    lastSender: 'member',
    createdAt: nowIso,
    ...(childUid ? { childUid, childName: deriveMemberName(trainee), payerUid: callerUid, payerName: getMemberFullName(payer!) } : {}),
  };

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: FORCA_TABLE_NAME, Item: inquiryItem } },
      { Put: { TableName: FORCA_TABLE_NAME, Item: { PK: inquiryKey.PK, SK: `MESSAGE#${randomUUID()}`, text: message, sender: 'member', createdAt: nowIso } } },
    ],
  }));

  await notifyForcaInquiryParticipants(inquiryItem, 'member', message);

  return json(200, { success: true, inquiryId });
}
