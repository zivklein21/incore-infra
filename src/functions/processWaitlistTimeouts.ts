// EventBridge Scheduled Rule — unix-cron "*/1 * * * *" (every minute).
// Expires pending waitlist entries that exceeded their 1-hour offer window,
// then cascades the offer to the next person in line.
import { ScanCommand, UpdateCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { ClassItem, WaitlistEntry } from '../lib/entities';
import { OFFER_WINDOW_MS, broadcastSpotOpen } from '../lib/waitlistCore';

export async function handler(): Promise<void> {
  const now = new Date();

  const classes: ClassItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk AND attribute_exists(waitlist)',
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':sk': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    classes.push(...(res.Items ?? []) as ClassItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  let expiredCount = 0;

  for (const classItem of classes) {
    const classId = classItem.PK.replace('CLASS#', '');
    const waitlist = classItem.waitlist ?? [];

    const timedOut = waitlist.filter((e) => {
      if (e.status !== 'pending') return false;
      if (!e.pendingSince) return true;
      return now.getTime() - new Date(e.pendingSince).getTime() >= OFFER_WINDOW_MS;
    });

    if (timedOut.length === 0) continue;

    const timedOutIds = new Set(timedOut.map((e) => e.member));
    const newWaitlist: WaitlistEntry[] = waitlist.filter((e) => !timedOutIds.has(e.member));

    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: classItem.PK, SK: classItem.SK },
      UpdateExpression: 'SET waitlist = :wl',
      ExpressionAttributeValues: { ':wl': newWaitlist },
    }));

    // Delete their stale offer messages (deterministic id spot_open_<classId>_<hourBucket>
    // — scan this member's messages for the waitlist_offer type on this class).
    for (const memberId of timedOutIds) {
      try {
        const msgsRes = await ddb.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          FilterExpression: '#type = :type AND classId = :classId',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MESSAGE#', ':type': 'waitlist_offer', ':classId': classId },
        }));
        await Promise.all((msgsRes.Items ?? []).map((item) =>
          ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } })),
        ));
        expiredCount++;
      } catch (err: any) {
        console.error(`[waitlist] failed to clean up messages for member=${memberId}`, err);
      }
    }

    // Cascade: offer the spot to the next waiting member.
    await broadcastSpotOpen(classId);
  }

  console.log(`[waitlist] processWaitlistTimeouts: expired ${expiredCount} pending entries`);
}
