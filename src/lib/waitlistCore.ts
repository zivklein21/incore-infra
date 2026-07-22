import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ClassItem, WaitlistEntry, MemberProfileItem } from './entities';
import { resolveTemplate, getMemberLang, fmtTime, fmtDate, type TemplateVars } from './templateResolver';

export const OFFER_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Offers a freed spot to the first 'waiting' member (FIFO by `since`).
// Shared by triggerWaitlistOffer.ts, rejectWaitlistOffer.ts, and (once
// ported) the deferred onClassBookingChanged trigger and
// processWaitlistTimeouts cron — one send path, matching the original's
// single broadcastSpotOpen used by all four callers.
export async function broadcastSpotOpen(classId: string): Promise<void> {
  console.log(`[waitlist] broadcastSpotOpen called for class=${classId}`);

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey }));
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return;

  if (classItem.isWaitlistEnabled === false) {
    console.log('[waitlist] waitlist explicitly disabled, skipping');
    return;
  }

  const currentAttendees = classItem.currentAttendeesCount ?? 0;
  const capacity = classItem.capacity ?? 5;
  if (currentAttendees >= capacity) {
    console.log('[waitlist] no free slots');
    return;
  }

  const waitlist = classItem.waitlist ?? [];
  if (waitlist.some((e) => e.status === 'pending')) {
    console.log('[waitlist] pending offer already active, skipping');
    return;
  }

  const first = waitlist
    .filter((e) => e.status === 'waiting')
    .sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime())[0];

  if (!first) {
    console.log('[waitlist] no waiting members');
    return;
  }

  const memberId = first.member;
  const nowIso = new Date().toISOString();
  const expiresAtMs = Date.now() + OFFER_WINDOW_MS;

  const newWaitlist: WaitlistEntry[] = waitlist.map((e) =>
    e.member === memberId ? { ...e, status: 'pending', pendingSince: nowIso } : e,
  );
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: classKey,
    UpdateExpression: 'SET waitlist = :waitlist',
    ExpressionAttributeValues: { ':waitlist': newWaitlist },
  }));

  const classDate = new Date(classItem.date);
  const classType = classItem.className ?? '';

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  const profile = memberRes.Item as MemberProfileItem | undefined;
  const lang = getMemberLang(profile ?? {});

  const vars: TemplateVars = {
    class_type: classType,
    class_time: fmtTime(classDate),
    class_date: fmtDate(classDate, lang),
    member_name: profile?.name ?? '',
  };

  const resolved = await resolveTemplate('SPOT_IS_OPEN', lang, vars);
  const title = resolved?.title ?? (lang === 'he' ? 'פתח מקום!' : 'Spot Available!');
  const body = resolved?.body ?? (lang === 'he'
    ? `מקום התפנה בשיעור ${classType} ב${vars.class_date} בשעה ${vars.class_time}. יש לך שעה לאשר.`
    : `A spot opened in ${classType} on ${vars.class_date} at ${vars.class_time}. You have 1 hour to confirm.`);

  // Deterministic ID prevents duplicate push from rapid Lambda retries.
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const msgId = `spot_open_${classId}_${hourBucket}`;

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${memberId}`,
        SK: `MESSAGE#${msgId}`,
        type: 'waitlist_offer',
        title,
        body,
        classId,
        className: classType,
        classDate: classDate.toISOString(),
        createdAt: nowIso,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtEpoch: Math.floor(expiresAtMs / 1000),
        requiresAction: true,
        actionExpiresAt: new Date(expiresAtMs).toISOString(),
        read: false,
      },
    }));
    console.log(`[waitlist] offered spot to member=${memberId} for class=${classId}`);
  } catch (err: any) {
    console.error(`[waitlist] offer message failed for member=${memberId}`, err);
  }
}
