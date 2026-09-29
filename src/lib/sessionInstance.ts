// Shared "materialize one concrete training session" logic — extracted out
// of createTrainingSession.ts so the same auto-register-every-group-member
// behavior can be reused by adminSaveRecurringSession.ts's template-driven
// generation without duplicating the Scan/Put/register sequence. See
// createTrainingSession.ts for the full behavioral write-up (repeat_weekly
// convention, isPrivate/allowedMemberIds construction, etc).

import { randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import { israelDateStr, israelWallTimeToDate, type GroupItem, type MemberProfileItem, type TrainingTypeItem, type WorkoutPlanItem } from './entities';

export interface CreateSessionInstanceParams {
  groupId: string;
  trainingTypeId: string;
  date: Date;
  /** Optional end time ("HH:mm", Israel wall-clock) carried over from the RecurringSessionItem template, if it has one set — combined with `date`'s own calendar day to compute ClassItem.endDate. Purely informational. */
  endTime?: string;
  createdBy: string;
  repeatWeekly?: boolean;
  seriesId?: string;
  location?: string;
  coachId?: string;
  coachName?: string;
  /** Set only for instances generated from a RecurringSessionItem template — see adminSaveRecurringSession.ts. */
  recurringSessionId?: string;
  /** Default Workout Plan/Test Group carried over from the RecurringSessionItem template, if it has one set — see adminSaveRecurringSession.ts. Mutually exclusive, same as ClassItem's own pair. */
  workoutPlanId?: string;
  workoutPlanName?: string;
  testGroupId?: string;
  testGroupName?: string;
  testComponentIds?: string[];
}

export type CreateSessionInstanceResult =
  | { ok: true; classId: string; registeredCount: number }
  | { ok: false; error: 'group_not_found' | 'training_type_not_found' };

export async function createSessionInstance(params: CreateSessionInstanceParams): Promise<CreateSessionInstanceResult> {
  const [groupRes, trainingTypeRes, workoutPlanRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${params.groupId}`, SK: 'METADATA' } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${params.trainingTypeId}`, SK: 'METADATA' } })),
    params.workoutPlanId
      ? ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${params.workoutPlanId}`, SK: 'METADATA' } }))
      : Promise.resolve(undefined),
  ]);
  const group = groupRes.Item as GroupItem | undefined;
  if (!group) return { ok: false, error: 'group_not_found' };
  const trainingType = trainingTypeRes.Item as TrainingTypeItem | undefined;
  if (!trainingType) return { ok: false, error: 'training_type_not_found' };
  // Running is the OR of two independent sources — the session's own
  // TrainingType category, or the Workout Plan carried over from the
  // template (if any) — see entities.ts's WorkoutPlanItem.category comment.
  const workoutPlan = workoutPlanRes?.Item as WorkoutPlanItem | undefined;
  const isRunningSession = trainingType.category === 'running' || workoutPlan?.category === 'running';

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getAllMemberProfiles()/getClassTypes.ts. identity is a
  // DynamoDB reserved keyword — bare here it fails every call.
  const membersRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND #identity.groupId = :groupId',
    ExpressionAttributeNames: { '#identity': 'identity' },
    ExpressionAttributeValues: { ':prefix': 'MEMBER#', ':profile': 'PROFILE', ':groupId': params.groupId },
  }));
  const members = (membersRes.Items ?? []) as MemberProfileItem[];
  // A group member with no admin-granted active membership window (see
  // adminGrantForcaMembership.ts — start/end dates on her own PROFILE item,
  // the same field the Overview tab's "Activity Validity" line already
  // reads) is skipped here rather than auto-registered. This only affects
  // sessions materialized from this point on — it never touches a
  // registration that already exists, same "new registrations only" scope
  // as INCORE's own bookClass.ts membership gate.
  // An empty group (no members yet, or none with an active membership
  // window) no longer blocks creating/scheduling a session for it — the
  // roster just starts empty and fills in as members are added/granted
  // membership later; this only affects sessions materialized from this
  // point on, same "new registrations only" scope as the membership-window
  // filter below.
  const now = Date.now();
  const memberIds = members
    .filter((m) => {
      const start = typeof m.membership?.start === 'string' ? new Date(m.membership.start).getTime() : NaN;
      const end = typeof m.membership?.end === 'string' ? new Date(m.membership.end).getTime() : NaN;
      return !Number.isNaN(start) && !Number.isNaN(end) && now >= start && now <= end;
    })
    .map((m) => (m.PK as string).replace('MEMBER#', ''));

  const classId = randomUUID();
  const nowIso = new Date().toISOString();
  // Same calendar day as `date`, just at endTime's wall-clock hour/minute —
  // mirrors how upcomingOccurrences()/occurrencesInMonth() construct `date`
  // itself from dayOfWeek+time.
  let endDate: string | undefined;
  if (params.endTime) {
    const [ey, em, ed] = israelDateStr(params.date).split('-').map(Number);
    const [ehh, emm] = params.endTime.split(':').map(Number);
    endDate = israelWallTimeToDate(ey, em - 1, ed, ehh, emm).toISOString();
  }
  const classItem: Record<string, unknown> = {
    PK: `CLASS#${classId}`,
    SK: 'METADATA',
    GSI2PK: `CLASSDATE#${israelDateStr(params.date)}`,
    GSI2SK: `CLASS#${classId}`,
    date: params.date.toISOString(),
    capacity: memberIds.length,
    currentAttendeesCount: memberIds.length,
    className: trainingType.name,
    notes: group.name,
    isWaitlistEnabled: false,
    waitlist: [],
    isPrivate: true,
    allowedMemberIds: memberIds,
    groupId: params.groupId,
    trainingTypeId: params.trainingTypeId,
    ...(isRunningSession ? { isRunningSession: true } : {}),
    equipmentTaken: [],
    repeat_weekly: params.repeatWeekly === true,
    ...(params.seriesId ? { series_id: params.seriesId } : {}),
    ...(endDate ? { endDate } : {}),
    ...(params.location ? { location: params.location } : {}),
    ...(params.coachId ? { coachId: params.coachId, coachName: params.coachName } : {}),
    ...(params.recurringSessionId ? { recurringSessionId: params.recurringSessionId } : {}),
    ...(params.workoutPlanId ? { workoutPlanId: params.workoutPlanId, workoutPlanName: params.workoutPlanName } : {}),
    ...(params.testGroupId ? {
      isTestSession: true, testGroupId: params.testGroupId, testGroupName: params.testGroupName,
      ...(params.testComponentIds && params.testComponentIds.length > 0 ? { testComponentIds: params.testComponentIds } : {}),
    } : {}),
    createdAt: nowIso,
    createdBy: params.createdBy,
  };

  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: classItem,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  await Promise.all(memberIds.map((uid) => ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: {
      PK: `CLASS#${classId}`,
      SK: `REG#${uid}`,
      GSI1PK: `MEMBER#${uid}`,
      GSI1SK: `REG##${classId}`,
      userId: uid,
      classId,
      classDate: classItem.date,
      status: 'REGISTERED',
      consumedFrom: 'FORCA_AUTO',
      membershipId: '',
      targetMonth: '',
      declaredAttendance: 'pending',
      actualAttendance: null,
      registeredAt: nowIso,
    },
  }))));

  return { ok: true, classId, registeredCount: memberIds.length };
}

/**
 * Normalizes a RecurringSessionItem's dayOfWeek field to an array —
 * RecurringSessionItem.dayOfWeek was a single number before the
 * multi-day-of-week feature; existing DynamoDB rows written before that
 * migration still have the old scalar shape (no backfill script, they're
 * simply read compatibly here forever). Every reader of stored
 * dayOfWeek data (adminSaveRecurringSession.ts, adminListRecurringSessions.ts,
 * adminGenerateMonthInstances.ts) goes through this instead of trusting the
 * stored shape directly.
 */
export function normalizeDaysOfWeek(v: unknown): number[] {
  if (Array.isArray(v)) return v.filter((n): n is number => typeof n === 'number');
  if (typeof v === 'number') return [v];
  return [];
}

/**
 * Every day (from `from` through the end of the Israel calendar month
 * `monthsAhead` months after `from`'s own — default 2, i.e. this month plus
 * the following two) that falls on any of `daysOfWeek`, at `time` ("HH:mm",
 * Israel wall-clock). `from` is normally "now", but a template edit that
 * changes the pattern regenerates starting from today (or an admin-chosen
 * start date — see adminSaveRecurringSession.ts) instead, same window.
 * Anything further out still needs adminGenerateMonthInstances.ts's own
 * per-month "generate" action (see ForcaMonthlyCalendarScreen.tsx) — this
 * just moves that manual step further into the future so a freshly created
 * template isn't empty the moment next month starts.
 *
 * All calendar-day arithmetic below happens on a Y/M/D counter anchored at
 * UTC midnight (never treated as a real instant, only read via the UTC
 * getters/setters) — that keeps "today", "Thursday", and "end of month"
 * evaluated against Israel's calendar, not the Lambda's own UTC clock,
 * which could disagree by a day near midnight. The real instant for each
 * occurrence is only constructed at the very end via israelWallTimeToDate(),
 * so a "Thursday 18:00" template always materializes at 18:00 Israel time
 * regardless of what timezone the Lambda process itself is running in.
 */
export function upcomingOccurrences(from: Date, daysOfWeek: number[], time: string, monthsAhead = 2): Date[] {
  const [hh, mm] = time.split(':').map((v) => parseInt(v, 10));
  const [fy, fm, fd] = israelDateStr(from).split('-').map(Number); // fm is 1-indexed
  const daySet = new Set(daysOfWeek);

  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  const monthEnd = new Date(Date.UTC(fy, fm + monthsAhead, 0)); // last calendar day of that later Israel month

  const dates: Date[] = [];
  while (cursor.getTime() <= monthEnd.getTime()) {
    if (daySet.has(cursor.getUTCDay())) {
      dates.push(israelWallTimeToDate(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), hh, mm));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Every day in the given Israel-calendar month (year, month1To12: 1=Jan)
 * that falls on any of `daysOfWeek`, at `time` — same wall-clock
 * construction as upcomingOccurrences() above, just bounded to an arbitrary
 * whole month instead of "from today through the end of the current
 * month". Used by adminGenerateMonthInstances.ts to bulk-materialize a
 * full month (including a future month the "from now" cap above would
 * leave ungenerated) in one admin action.
 */
export function occurrencesInMonth(year: number, month1To12: number, daysOfWeek: number[], time: string): Date[] {
  const [hh, mm] = time.split(':').map((v) => parseInt(v, 10));
  const daySet = new Set(daysOfWeek);

  const cursor = new Date(Date.UTC(year, month1To12 - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month1To12, 0)); // last calendar day of that month

  const dates: Date[] = [];
  while (cursor.getTime() <= monthEnd.getTime()) {
    if (daySet.has(cursor.getUTCDay())) {
      dates.push(israelWallTimeToDate(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), hh, mm));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Every Israel-calendar date string (`YYYY-MM-DD`, matching a ClassItem's
 * own GSI2PK `CLASSDATE#<date>` — see the item literal above) from
 * `fromIso` through the day before `toIso` (exclusive), inclusive of
 * `fromIso`'s own day. Same UTC-midnight-anchored Y/M/D counter as
 * upcomingOccurrences()/occurrencesInMonth() above — this is pure calendar
 * arithmetic on the two boundary date strings, not a real-instant walk, so
 * it's immune to DST drift. Powers getCoachSessions.ts's day-by-day GSI2
 * fan-out, which replaced an unbounded full-table Scan that kept getting
 * slower as session history grew (that Scan cost was driven by the WHOLE
 * table's item count, not just sessions, since a Scan reads every item
 * before any FilterExpression is applied).
 */
export function israelDateStrRange(fromIso: string, toIso: string): string[] {
  const fromDateStr = israelDateStr(new Date(fromIso));
  const toDateStr = israelDateStr(new Date(toIso));
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));

  const dateStrs: string[] = [];
  // Safety cap — the callers bound their own windows (≤ a few hundred
  // days), this just guards against an accidental unbounded range.
  for (let i = 0; i < 1000; i++) {
    const dateStr = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}-${String(cursor.getUTCDate()).padStart(2, '0')}`;
    if (dateStr >= toDateStr) break;
    dateStrs.push(dateStr);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dateStrs;
}

/**
 * Deletes one ClassItem and every registration under it (CLASS#<id>/REG#*)
 * — the shared "fully remove this one session instance" primitive both
 * deleteFutureInstances() below (a whole recurring template's future set)
 * and adminCancelSessionInstance.ts (one specific instance, admin-cancelled
 * from the calendar) build on, so the two never drift on what "delete an
 * instance" actually means.
 */
export async function deleteSessionInstance(classId: string): Promise<void> {
  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
  }));
  const regs = (regsRes.Items ?? []) as { SK: string }[];
  await Promise.all(regs.map((r) =>
    ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: r.SK } })),
  ));
  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
}

/**
 * Every not-yet-occurred ClassItem generated from `recurringSessionId` —
 * used both by adminSaveRecurringSession.ts (pattern change ⇒ delete +
 * regenerate) and adminDeleteRecurringSession.ts (template removed ⇒ future
 * occurrences shouldn't happen either). Past instances are never touched —
 * they're the historical record getTrainingHistory.ts reads.
 */
export async function deleteFutureInstances(recurringSessionId: string): Promise<number> {
  const nowIso = new Date().toISOString();
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'recurringSessionId = :rsid AND #dt >= :now',
    ExpressionAttributeNames: { '#dt': 'date' },
    ExpressionAttributeValues: { ':rsid': recurringSessionId, ':now': nowIso },
  }));
  const items = (res.Items ?? []) as { PK: string }[];

  await Promise.all(items.map((item) => deleteSessionInstance(item.PK.replace('CLASS#', ''))));

  return items.length;
}
