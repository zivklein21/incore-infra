import { QueryCommand, UpdateCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { deriveMemberName, type ClassItem, type RegistrationItem, type MemberProfileItem } from './entities';
import { getReminderSettings } from './notificationTiming';
import { fmtTime, fmtDate, getMemberLang } from './templateResolver';
import { israelHour, israelDateStrOf, israelHourToUTC } from './israelTime';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK_SZ = 100;
const LOOKAHEAD_HOURS = 48;

interface RawTemplate {
  titleHe: string; titleEn: string; bodyHe: string; bodyEn: string; bgColor: string; textColor: string;
}
interface PushMsg { to: string; title: string; body: string; sound: 'default'; data: Record<string, string> }

/**
 * Which hourly cron tick should send this class's reminder, given the
 * admin-configured hoursBefore + [windowStartHour, windowEndHour) send window.
 * See functions/src/classReminders.ts computeSendBucket for the full
 * clamping rationale — ported unchanged.
 */
function computeSendBucket(classDate: Date, hoursBefore: number, windowStartHour: number, windowEndHour: number): { start: Date; end: Date } {
  const naiveStart = new Date(classDate.getTime() - hoursBefore * 3_600_000);
  const naiveHour = israelHour(naiveStart);
  const dayStr = israelDateStrOf(naiveStart);

  const targetHour =
    naiveHour < windowStartHour ? windowStartHour :
    naiveHour >= windowEndHour ? windowEndHour - 1 :
    naiveHour;

  const bucketStart = israelHourToUTC(dayStr, targetHour);
  return { start: bucketStart, end: new Date(bucketStart.getTime() + 3_600_000) };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function applyVars(text: string, vars: { class_type: string; class_time: string; class_date: string; member_name: string }): string {
  return text
    .replace(/\{class_type\}/g, vars.class_type)
    .replace(/\{class_time\}/g, vars.class_time)
    .replace(/\{class_date\}/g, vars.class_date)
    .replace(/\{member_name\}/g, vars.member_name);
}

function resolveFromRaw(raw: RawTemplate, lang: 'he' | 'en', vars: { class_type: string; class_time: string; class_date: string; member_name: string }) {
  const rawTitle = lang === 'he' ? (raw.titleHe.trim() || raw.titleEn.trim()) : (raw.titleEn.trim() || raw.titleHe.trim());
  const rawBody = lang === 'he' ? (raw.bodyHe.trim() || raw.bodyEn.trim()) : (raw.bodyEn.trim() || raw.bodyHe.trim());
  return {
    title: applyVars(rawTitle || 'INCORE', vars),
    body: applyVars(rawBody || '', vars),
    bgColor: raw.bgColor || '#5C3A8F',
    textColor: raw.textColor || '#FFFFFF',
  };
}

function getExpoPushToken(profile: MemberProfileItem): string {
  return profile.device?.expo_push_token ?? profile.device?.expoPushToken ?? profile.expoPushToken ?? '';
}

// Finds every class in the next LOOKAHEAD_HOURS via GSI2 (CLASSDATE#<day>,
// bucketed by day — see bookClass.ts's key-design notes), spanning however
// many calendar days the window covers, then filters to the precise range.
async function findUpcomingClasses(now: Date, lookaheadEnd: Date): Promise<Array<ClassItem & { classId: string }>> {
  const dayStrs = new Set<string>();
  for (let t = now.getTime(); t <= lookaheadEnd.getTime(); t += 3_600_000) {
    dayStrs.add(israelDateStrOf(new Date(t)));
  }
  dayStrs.add(israelDateStrOf(lookaheadEnd));

  const results: Array<ClassItem & { classId: string }> = [];
  for (const dayStr of dayStrs) {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `CLASSDATE#${dayStr}` },
    }));
    for (const item of (res.Items ?? []) as ClassItem[]) {
      const d = new Date(item.date);
      if (d >= now && d < lookaheadEnd) {
        results.push({ ...item, classId: item.PK.replace('CLASS#', '') });
      }
    }
  }
  return results;
}

// Core reminder logic — shared between the classReminderEngine cron
// (functions/src/classReminders.ts, deferred to the EventBridge pass) and
// testClassReminder.ts, exactly like the original shared runClassReminderEngine.
export async function runClassReminderEngine(): Promise<Record<string, unknown>> {
  const log: Record<string, unknown> = {};
  const now = new Date();
  log.nowUtc = now.toISOString();

  const { hoursBefore, windowStartHour, windowEndHour } = await getReminderSettings();
  log.hoursBefore = hoursBefore;
  log.windowStartHour = windowStartHour;
  log.windowEndHour = windowEndHour;

  const tplRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'TEMPLATETYPE#REMINDER' },
    Limit: 1,
  }));
  const rawTemplate = (tplRes.Items ?? [])[0] as (RawTemplate & { templateId: string }) | undefined;
  if (!rawTemplate) {
    log.result = 'NO_TEMPLATE — create a notificationTemplates item with type="REMINDER"';
    console.warn('[classReminderEngine]', log.result);
    return log;
  }
  log.templateId = rawTemplate.templateId;

  let totalPushed = 0;
  let totalWritten = 0;

  const lookaheadEnd = new Date(now.getTime() + LOOKAHEAD_HOURS * 3_600_000);
  const upcoming = await findUpcomingClasses(now, lookaheadEnd);

  const dueClasses = upcoming.filter((c) => {
    const bucket = computeSendBucket(new Date(c.date), hoursBefore, windowStartHour, windowEndHour);
    return now >= bucket.start && now < bucket.end;
  });
  log.dueClasses = dueClasses.length;

  if (dueClasses.length === 0) {
    log.result = 'no classes due for a reminder this hour';
    return log;
  }

  for (const classItem of dueClasses) {
    const classId = classItem.classId;
    const classDate = new Date(classItem.date);
    const classTypeName = classItem.className ?? '';

    const regsRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    }));
    const registrations = (regsRes.Items ?? []) as RegistrationItem[];
    const pending = registrations.filter((r) => r.reminderSent !== true);

    if (pending.length === 0) {
      console.log(`[classReminderEngine] class ${classId}: all already reminded`);
      continue;
    }
    console.log(`[classReminderEngine] class ${classId}: ${pending.length} pending`);

    const memberResults = await Promise.all(pending.map((r) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${r.userId}`, SK: 'PROFILE' } }))));
    const memberMap = new Map<string, MemberProfileItem>();
    pending.forEach((r, i) => {
      const item = memberResults[i].Item as MemberProfileItem | undefined;
      if (item) memberMap.set(r.userId, item);
    });

    const pushBatch: PushMsg[] = [];
    const dbWrites: Array<() => Promise<unknown>> = [];

    for (const reg of pending) {
      const memberId = reg.userId;
      const profile = memberMap.get(memberId);
      if (!profile) continue;

      const lang = getMemberLang(profile);
      const msg = resolveFromRaw(rawTemplate, lang, {
        class_type: classTypeName,
        class_time: fmtTime(classDate),
        class_date: fmtDate(classDate, lang),
        member_name: deriveMemberName(profile),
      });

      const token = getExpoPushToken(profile);
      if (token.startsWith('ExponentPushToken')) {
        pushBatch.push({ to: token, title: msg.title, body: msg.body, sound: 'default', data: { type: 'reminder', classId } });
      }

      const nowIso = new Date().toISOString();
      dbWrites.push(() => ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `MEMBER#${memberId}`,
          SK: `MESSAGE#reminder_${classId}`,
          type: 'reminder',
          title: msg.title,
          body: msg.body,
          bgColor: msg.bgColor,
          textColor: msg.textColor,
          classId,
          classDate: classItem.date,
          createdAt: nowIso,
          expiresAt: classItem.date,
          requiresAction: false,
          read: false,
          suppressPush: true,
        },
      })));

      dbWrites.push(() => ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CLASS#${classId}`, SK: `REG#${memberId}` },
        UpdateExpression: 'SET reminderSent = :true, reminderSentAt = :now',
        ExpressionAttributeValues: { ':true': true, ':now': nowIso },
      })));
    }

    for (const batch of chunk(pushBatch, EXPO_CHUNK_SZ)) {
      try {
        const resp = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(batch),
        });
        const result = await resp.json();
        console.log(`[classReminderEngine] push (${batch.length}):`, JSON.stringify(result));
        totalPushed += batch.length;
      } catch (err: any) {
        console.error('[classReminderEngine] push batch error:', err);
      }
    }

    await Promise.all(dbWrites.map((fn) => fn()));
    totalWritten += pending.length;
  }

  log.totalPushed = totalPushed;
  log.totalWritten = totalWritten;
  return log;
}
