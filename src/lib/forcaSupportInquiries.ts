import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import { notifyAdmins } from './adminNotify';
import { getExpoPushToken, sendExpoPush } from './push';
import type { ForcaSupportInquiryItem, MemberProfileItem } from './entities';

// Shared push-notification fan-out for both createForcaSupportInquiry.ts
// and sendForcaSupportMessage.ts — fire-and-forget, never throws (a failed
// notification must never block the message itself from being sent/saved).
// No AWS WebSocket transport exists yet (same as every other list in this
// app), so this is purely a "someone should know to go check the app"
// nudge — the actual message list is always fetched fresh/polled.
export async function notifyForcaInquiryParticipants(
  inquiry: ForcaSupportInquiryItem,
  senderRole: 'member' | 'admin' | 'coach',
  text: string,
): Promise<void> {
  try {
    if (senderRole === 'member') {
      const title = `הודעה חדשה מ-${inquiry.userDisplayName || 'מתאמנת'}`;
      if (inquiry.recipientRole === 'admin') {
        // Admin accounts only ever live in the INCORE table (isAdmin()
        // itself always checks TABLE_NAME) — reuse the existing
        // INCORE-table admin fan-out as-is, same as forcaBillingAgreements.ts's
        // notifyAdminsPaymentFailed reuse.
        await notifyAdmins({
          type: 'FORCA_INQUIRY',
          priority: 'NORMAL',
          pushTitle: title,
          message: text,
          extra: { inquiryId: inquiry.PK.replace('FORCAINQUIRY#', '') },
          pushData: { screen: 'SupportInquiries' },
        });
        return;
      }

      // recipientRole === 'coach' — every coach currently assigned to the
      // inquiry's (pinned-at-creation) group, same "coach owns her
      // assigned groups" model as getCoachAccess()/groupInAccess().
      if (!inquiry.groupId) return;
      const res = await ddb.send(new ScanCommand({
        TableName: FORCA_TABLE_NAME,
        FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND #identity.#role = :coach',
        ExpressionAttributeNames: { '#identity': 'identity', '#role': 'role' },
        ExpressionAttributeValues: { ':prefix': 'MEMBER#', ':profile': 'PROFILE', ':coach': 'coach' },
      }));
      const coaches = ((res.Items ?? []) as MemberProfileItem[])
        .filter((c) => (c.identity?.groupIds ?? []).includes(inquiry.groupId!));
      await Promise.all(coaches.map(async (coach) => {
        const token = getExpoPushToken(coach);
        if (token) await sendExpoPush(token, title, text, { screen: 'ForcaCoachInquiries' });
      }));
      return;
    }

    // admin or coach replied — notify the trainee, and her parent too if
    // this conversation was started on her behalf.
    const targetUids = new Set([inquiry.userId, ...(inquiry.payerUid ? [inquiry.payerUid] : [])]);
    const title = senderRole === 'coach' ? 'הודעה חדשה מהמאמנת' : 'הודעה חדשה מהצוות';
    await Promise.all(Array.from(targetUids).map(async (uid) => {
      const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
      const profile = res.Item as MemberProfileItem | undefined;
      if (!profile) return;
      const token = getExpoPushToken(profile);
      if (token) await sendExpoPush(token, title, text, { screen: 'ForcaChat' });
    }));
  } catch (err: any) {
    console.error('[notifyForcaInquiryParticipants] failed:', err);
  }
}
