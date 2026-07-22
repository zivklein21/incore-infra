// EventBridge Scheduled Rule — unix-cron "0 9 * * *" (09:00 daily), Asia/Jerusalem.
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getAllMemberProfiles } from '../lib/memberScan';
import { israelDateStrOffset, membershipEndStr, sendReminder } from '../lib/membershipReminders';

export async function handler(): Promise<void> {
  const target7 = israelDateStrOffset(7);
  const target3 = israelDateStrOffset(3);

  const profiles = await getAllMemberProfiles();
  const tasks: Promise<unknown>[] = [];

  for (const profile of profiles) {
    const memberId = profile.PK.replace('MEMBER#', '');
    const status = profile.membership?.status as string | undefined;
    const endStr = membershipEndStr(profile);
    if (!endStr || status === 'expired') continue;

    const sent7 = profile.membership?.reminder7dSent as string | undefined;
    const sent3 = profile.membership?.reminder3dSent as string | undefined;

    if (endStr === target7 && sent7 !== endStr) {
      tasks.push(
        sendReminder(memberId, profile, 'MEMBERSHIP_ALERT', endStr)
          .then(() => ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: profile.PK, SK: profile.SK },
            UpdateExpression: 'SET membership.reminder7dSent = :v',
            ExpressionAttributeValues: { ':v': endStr },
          })))
          .catch((err) => console.error(`[membershipReminders] 7d ${memberId}:`, err)),
      );
    }

    if (endStr === target3 && sent3 !== endStr) {
      tasks.push(
        sendReminder(memberId, profile, 'MEMBERSHIP_ALERT', endStr)
          .then(() => ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: profile.PK, SK: profile.SK },
            UpdateExpression: 'SET membership.reminder3dSent = :v',
            ExpressionAttributeValues: { ':v': endStr },
          })))
          .catch((err) => console.error(`[membershipReminders] 3d ${memberId}:`, err)),
      );
    }
  }

  await Promise.all(tasks);
  console.log(`[sendMembershipReminders] done — ${profiles.length} members checked, ${tasks.length} reminders queued`);
}
