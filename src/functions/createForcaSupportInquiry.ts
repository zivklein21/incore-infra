import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { deriveMemberName, type ForcaSupportInquiryItem, type GroupItem, type MemberProfileItem } from '../lib/entities';
import { activitySk, messageSk, recipientPartition } from '../lib/forcaChat/access';
import { listForcaCoaches, notifyChat, resolveChatCaller } from '../lib/forcaChat/store';
import { autoReplyFor, getForcaChatSettings } from '../lib/forcaChat/settings';

// POST /createForcaSupportInquiry
// Body: { subject, message, recipientRole: 'admin' | 'coach', recipientUid?, childUid? }
// Auth: Cognito JWT, FORCA trainees and parents only (not coaches or admins).
//
// The thread belongs to the caller. A parent passes childUid (family-link
// checked) for the child it's about; it lands in the PARENT's inbox, never
// the child's. recipientUid picks one coach of that child's group (app 1.5.2+).
// Without it (app versions in the stores) a coach thread goes to the group's
// only coach, or stays a group thread when the group has several.
// The admin's auto-reply for that recipient (lib/forcaChat/settings.ts) is
// added by the server, so it reaches every app version.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { subject?: unknown; message?: unknown; recipientRole?: unknown; recipientUid?: unknown; childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const recipientRole = body.recipientRole === 'admin' || body.recipientRole === 'coach' ? body.recipientRole : '';
  if (!subject || message.length < 5 || !recipientRole) return json(400, { error: 'invalid_fields' });
  const requestedCoach = typeof body.recipientUid === 'string' ? body.recipientUid.trim() : '';
  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';

  const [caller, settings] = await Promise.all([resolveChatCaller(callerUid), getForcaChatSettings()]);
  if (caller.isAdmin || caller.coachGroupIds) return json(403, { error: 'members_only' });
  if (!caller.profile) return json(404, { error: 'member_not_found' });
  const isParent = caller.profile.identity?.accountType === 'parent_only';
  if (isParent && !childUid) return json(400, { error: 'child_required' });

  let trainee: MemberProfileItem = caller.profile;
  if (childUid) {
    const link = await verifyFamilyLink(callerUid, childUid);
    if (!link.ok) return json(403, { error: 'forbidden' });
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${childUid}`, SK: 'PROFILE' } }));
    if (!res.Item) return json(404, { error: 'member_not_found' });
    trainee = res.Item as MemberProfileItem;
  }
  const traineeUid = childUid || callerUid;

  let groupId: string | undefined;
  let groupName: string | undefined;
  let recipientUid: string | undefined;
  let recipientName: string | undefined;
  if (recipientRole === 'coach') {
    groupId = trainee.identity?.groupId;
    if (!groupId) return json(400, { error: 'no_group_assigned' });
    const [groupRes, groupCoaches] = await Promise.all([
      ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } })),
      listForcaCoaches().then((all) => all.filter((c) => c.groupIds.includes(groupId!))),
    ]);
    groupName = (groupRes.Item as GroupItem | undefined)?.name;
    const coach = requestedCoach
      ? groupCoaches.find((c) => c.uid === requestedCoach)
      : groupCoaches.length === 1 ? groupCoaches[0] : undefined;
    if (requestedCoach && !coach) return json(400, { error: 'coach_not_assigned' });
    recipientUid = coach?.uid;
    recipientName = coach?.name;
  }

  const inquiryId = randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  // The auto-reply lands 1 ms after her message, as INCORE's does. The thread
  // shows it as the last message, but lastSender stays 'member' so it's
  // still unread for the recipient, and she has read it herself.
  const autoReply = autoReplyFor(settings, recipientRole);
  const lastIso = autoReply ? new Date(now.getTime() + 1).toISOString() : nowIso;
  const inquiryKey = { PK: `FORCAINQUIRY#${inquiryId}`, SK: 'METADATA' };
  const ownerName = deriveMemberName(caller.profile);
  const traineeName = deriveMemberName(trainee);
  const partition = recipientPartition({ recipientRole, recipientUid, groupId });

  const inquiryItem: ForcaSupportInquiryItem = {
    ...inquiryKey,
    GSI1PK: `MEMBER#${callerUid}`,
    GSI1SK: `FORCAINQUIRY#${nowIso}#${inquiryId}`,
    GSI2PK: 'FORCAINQUIRY',
    GSI2SK: activitySk(lastIso, inquiryId),
    ...(partition ? { GSI3PK: partition, GSI3SK: activitySk(lastIso, inquiryId) } : {}),
    status: 'OPEN',
    ownerUid: callerUid,
    ownerRole: childUid ? 'parent' : 'trainee',
    ownerName,
    ...(childUid ? { aboutChildUid: childUid, aboutChildName: traineeName } : {}),
    // The trainee the thread is about, under the field names older builds read.
    userId: traineeUid,
    userDisplayName: traineeName,
    userEmail: trainee.identity?.email ?? trainee.email ?? '',
    recipientRole,
    ...(recipientUid ? { recipientUid, recipientName } : {}),
    ...(groupId ? { groupId, groupName: groupName ?? '' } : {}),
    subject,
    lastMessage: autoReply ?? message,
    lastMessageAt: lastIso,
    lastSender: 'member',
    memberReadAt: lastIso,
    sortableMessages: true,
    createdAt: nowIso,
    ...(childUid ? { childUid, childName: traineeName, payerUid: callerUid, payerName: ownerName } : {}),
  };

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: FORCA_TABLE_NAME, Item: inquiryItem } },
      {
        Put: {
          TableName: FORCA_TABLE_NAME,
          Item: { PK: inquiryKey.PK, SK: messageSk(nowIso, randomUUID()), text: message, sender: 'member', senderUid: callerUid, senderName: ownerName, createdAt: nowIso },
        },
      },
      ...(autoReply ? [{
        Put: {
          TableName: FORCA_TABLE_NAME,
          Item: {
            PK: inquiryKey.PK, SK: messageSk(lastIso, randomUUID()), text: autoReply,
            sender: recipientRole, isAutoReply: true, senderName: 'הודעה אוטומטית', createdAt: lastIso,
          },
        },
      }] : []),
    ],
  }));

  await notifyChat(inquiryItem, 'member', message);

  return json(200, { success: true, inquiryId });
}
