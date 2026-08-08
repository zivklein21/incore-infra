import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ClassItem, RegistrationItem } from './entities';
import { writeNotification, getMemberProfile } from './classNotifications';
import { getMemberLang, fmtTime, fmtDate } from './templateResolver';

const MIN_NOTICE_HOURS = 2;

// Fired after a cancellation transaction commits, whichever path caused it
// (member self-cancel or admin cancel) — tells the one trainee left in the
// class she's currently alone, so she can move to another session instead.
// Skipped inside MIN_NOTICE_HOURS of class start (too late to be useful) and
// naturally deduped by writeNotification's deterministic MESSAGE# key —
// onMessageCreated only pushes on INSERT, so re-triggering this for the same
// class is a silent no-op, not a repeat alert.
export async function maybeSendSoleAttendeeAlert(
  classId: string,
  classItem: ClassItem,
  remainingAfterCancel: number,
): Promise<void> {
  if (remainingAfterCancel !== 1) return;

  const classDate = new Date(classItem.date);
  const hoursUntilClass = (classDate.getTime() - Date.now()) / 3_600_000;
  if (hoursUntilClass < MIN_NOTICE_HOURS) return;

  const remainingRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :registered',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
  }));
  const remaining = (remainingRes.Items ?? [])[0] as RegistrationItem | undefined;
  if (!remaining) return;

  const profile = await getMemberProfile(remaining.userId);
  if (!profile) return;

  const lang = getMemberLang(profile);
  const className = classItem.className ?? '';
  const classTime = fmtTime(classDate);
  const classDateStr = fmtDate(classDate, lang);

  const title = lang === 'he'
    ? 'שימי לב: נשארת יחידה באימון 🏋️‍♀️'
    : "Heads up: you're the only one booked 🏋️‍♀️";
  const body = lang === 'he'
    ? `היי, כרגע את הרשומה היחידה לאימון ${className} ב-${classDateStr} בשעה ${classTime}. במידה ותעדיפי, תוכלי לעבור לאימון אחר בלו"ז.`
    : `Hi, you're currently the only one signed up for ${className} at ${classTime} on ${classDateStr}. You're welcome to switch to another class instead.`;

  await writeNotification(
    remaining.userId,
    classId,
    className,
    classDate,
    { title, body, bgColor: '#5C3A8F', textColor: '#FFFFFF' },
    'sole_attendee',
  );

  console.log(`[soleAttendeeAlert] dispatched: class=${classId} trainee=${remaining.userId}`);
}
