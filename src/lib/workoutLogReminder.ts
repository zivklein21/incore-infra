import { BatchGetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ClassItem, MemberProfileItem, RegistrationItem } from './entities';
import { israelDateStrOf } from './israelTime';
import { getMemberLang } from './templateResolver';
import { getExpoPushToken, sendExpoPushBatch, type ExpoPushMessage } from './push';
import { getWorkoutLogReminderSettings, type WorkoutLogReminderSettings } from './notificationTiming';

// INCORE "log your workout" push (scheduled every 15 minutes, see
// functions/workoutLogReminders.ts).
//
// A class is due once its end + delayMinutes has passed, for CATCH_UP_MS
// after that (so one missed run still sends, but an old class never starts
// nagging after the setting is switched on). For each REGISTERED member of a
// due class (the same "attended" rule the Workout Journal uses for its
// "waiting to be logged" list):
//   - skip when WORKOUTLOG#cls_<classId> already exists (already logged);
//   - claim CLASS#<id> / LOGREMIND#<uid> with attribute_not_exists, and send
//     only when the claim succeeds, so a member gets at most one reminder
//     per class even if runs overlap or retry.
// The claim is written before the push: a failed send means no reminder,
// never two.
//
// Push data uses `logClassId`, not `classId`: app versions already in the
// stores open BookClass for any push carrying `classId`.

export const CATEGORY_ID = 'workout_log_reminder';
export const CATCH_UP_MS = 2 * 60 * 60 * 1000;
/** Used when a class has no endDate (INCORE classes don't store one). */
export const DEFAULT_CLASS_MINUTES = 60;
const LONGEST_CLASS_MS = 4 * 60 * 60 * 1000;
const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;

export function classEndMs(cls: Pick<ClassItem, 'date' | 'endDate'>): number {
  const end = cls.endDate ? new Date(cls.endDate).getTime() : NaN;
  return Number.isFinite(end) ? end : new Date(cls.date).getTime() + DEFAULT_CLASS_MINUTES * 60_000;
}

/** Classes whose reminder time (end + delay) is in (now - CATCH_UP_MS, now]. Pure; exported for tests. */
export function selectDueClasses<T extends Pick<ClassItem, 'date' | 'endDate' | 'groupId'>>(
  classes: T[], settings: WorkoutLogReminderSettings, nowMs: number,
): T[] {
  if (!settings.enabled) return [];
  const delayMs = settings.delayMinutes * 60_000;
  return classes.filter((c) => {
    if (c.groupId) return false; // FORCA training sessions: different logging model
    const dueAt = classEndMs(c) + delayMs;
    return dueAt <= nowMs && dueAt > nowMs - CATCH_UP_MS;
  });
}

export function reminderText(lang: 'he' | 'en', className: string): { title: string; body: string } {
  const name = className.trim();
  return lang === 'en'
    ? { title: 'Log your workout', body: name ? `How was ${name}? Log your weights while you remember them.` : 'Log your weights while you remember them.' }
    : { title: 'תיעוד אימון', body: name ? `איך היה ${name}? זה הזמן לתעד את המשקלים.` : 'זה הזמן לתעד את המשקלים מהאימון.' };
}

async function classesStartingBetween(fromMs: number, toMs: number): Promise<Array<ClassItem & { classId: string }>> {
  const days = new Set<string>();
  for (let t = fromMs; t <= toMs; t += 3_600_000) days.add(israelDateStrOf(new Date(t)));
  days.add(israelDateStrOf(new Date(toMs)));

  const out: Array<ClassItem & { classId: string }> = [];
  for (const day of days) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `CLASSDATE#${day}` },
        ExclusiveStartKey: startKey,
      }));
      for (const item of (res.Items ?? []) as ClassItem[]) {
        const t = new Date(item.date).getTime();
        if (t >= fromMs && t <= toMs) out.push({ ...item, classId: item.PK.replace('CLASS#', '') });
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
  }
  return out;
}

async function batchGet(keys: { PK: string; SK: string }[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < keys.length; i += 100) {
    let pending: Record<string, unknown>[] | undefined = keys.slice(i, i + 100);
    for (let attempt = 0; pending && pending.length > 0 && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: pending } } }));
      for (const item of (res.Responses?.[TABLE_NAME] ?? []) as Record<string, unknown>[]) out.set(`${item.PK}|${item.SK}`, item);
      pending = res.UnprocessedKeys?.[TABLE_NAME]?.Keys as Record<string, unknown>[] | undefined;
      if (pending && pending.length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
  return out;
}

/** True when this run claimed the reminder; false when one was already claimed. */
async function claimReminder(classId: string, uid: string, nowMs: number): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `CLASS#${classId}`, SK: `LOGREMIND#${uid}`,
        userId: uid, sentAt: new Date(nowMs).toISOString(),
        expiresAtEpoch: Math.floor(nowMs / 1000) + CLAIM_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function runWorkoutLogReminders(now: Date = new Date()): Promise<Record<string, unknown>> {
  const nowMs = now.getTime();
  const settings = await getWorkoutLogReminderSettings();
  const log: Record<string, unknown> = { nowUtc: now.toISOString(), ...settings };
  if (!settings.enabled) return { ...log, result: 'disabled' };

  const delayMs = settings.delayMinutes * 60_000;
  const candidates = await classesStartingBetween(nowMs - delayMs - CATCH_UP_MS - LONGEST_CLASS_MS, nowMs);
  const due = selectDueClasses(candidates, settings, nowMs);
  log.dueClasses = due.length;

  const messages: ExpoPushMessage[] = [];
  let skippedLogged = 0;
  let skippedClaimed = 0;

  for (const cls of due) {
    const regsRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `CLASS#${cls.classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    }));
    const uids = [...new Set(((regsRes.Items ?? []) as RegistrationItem[]).map((r) => r.userId).filter(Boolean))];
    if (uids.length === 0) continue;

    const found = await batchGet(uids.flatMap((uid) => [
      { PK: `MEMBER#${uid}`, SK: `WORKOUTLOG#cls_${cls.classId}` },
      { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    ]));

    for (const uid of uids) {
      if (found.has(`MEMBER#${uid}|WORKOUTLOG#cls_${cls.classId}`)) { skippedLogged++; continue; }
      const profile = found.get(`MEMBER#${uid}|PROFILE`) as MemberProfileItem | undefined;
      const token = profile ? getExpoPushToken(profile) : null;
      if (!profile || !token) continue;
      if (!(await claimReminder(cls.classId, uid, nowMs))) { skippedClaimed++; continue; }
      const { title, body } = reminderText(getMemberLang(profile), cls.className ?? '');
      messages.push({
        to: token, title, body, sound: 'default',
        categoryId: CATEGORY_ID,
        data: { type: CATEGORY_ID, logClassId: cls.classId },
      });
    }
  }

  const accepted = messages.length > 0 ? await sendExpoPushBatch(messages, 'workoutLogReminders') : 0;
  return { ...log, queued: messages.length, accepted, skippedLogged, skippedClaimed };
}
