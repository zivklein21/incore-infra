// Shared "materialize one concrete training session" logic — extracted out
// of createTrainingSession.ts so the same auto-register-every-group-member
// behavior can be reused by adminSaveRecurringSession.ts's template-driven
// generation without duplicating the Scan/Put/register sequence. See
// createTrainingSession.ts for the full behavioral write-up (repeat_weekly
// convention, isPrivate/allowedMemberIds construction, etc).

import { randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, type ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import { israelDateStr, israelWallTimeToDate, type ClassItem, type GroupItem,type MemberProfileItem, type TrainingTypeItem, type WorkoutPlanItem } from './entities';

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
  /**
   * A SPECIAL ACTIVITY (Manage → Activities — a trip, an event…) instead of a
   * typed training: its own name + description, no training type needed.
   * Same calendar item and same group auto-registration as any session, so
   * it shows in the calendar and its roster is the group — which is what
   * forms attached to it go to (formTemplates "activity" assignments).
   */
  activity?: { name: string; description?: string };
}

export type CreateSessionInstanceResult =
  | { ok: true; classId: string; registeredCount: number }
  | { ok: false; error: 'group_not_found' | 'training_type_not_found' };

export async function createSessionInstance(params: CreateSessionInstanceParams): Promise<CreateSessionInstanceResult> {
  const [groupRes, trainingTypeRes, workoutPlanRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${params.groupId}`, SK: 'METADATA' } })),
    params.trainingTypeId
      ? ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${params.trainingTypeId}`, SK: 'METADATA' } }))
      : Promise.resolve({ Item: undefined }),
    params.workoutPlanId
      ? ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${params.workoutPlanId}`, SK: 'METADATA' } }))
      : Promise.resolve(undefined),
  ]);
  const group = groupRes.Item as GroupItem | undefined;
  if (!group) return { ok: false, error: 'group_not_found' };
  const trainingType = trainingTypeRes.Item as TrainingTypeItem | undefined;
  if (!trainingType && !params.activity) return { ok: false, error: 'training_type_not_found' };
  // Running is the OR of two independent sources — the session's own
  // TrainingType category, or the Workout Plan carried over from the
  // template (if any) — see entities.ts's WorkoutPlanItem.category comment.
  const workoutPlan = workoutPlanRes?.Item as WorkoutPlanItem | undefined;
  const isRunningSession = trainingType?.category === 'running' || workoutPlan?.category === 'running';

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getAllMemberProfiles()/getClassTypes.ts. identity is a
  // DynamoDB reserved keyword — bare here it fails every call.
  // Paginated: a filtered Scan only evaluates 1MB per page, and this table
  // also holds every ClassItem/RegistrationItem, so a single page silently
  // misses group members once the table outgrows it.
  const members = (await scanAll({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND #identity.groupId = :groupId',
    ExpressionAttributeNames: { '#identity': 'identity' },
    ExpressionAttributeValues: { ':prefix': 'MEMBER#', ':profile': 'PROFILE', ':groupId': params.groupId },
  })) as unknown as MemberProfileItem[];
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
    .filter((m) => hasActiveForcaMembership(m, now))
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
    className: params.activity ? params.activity.name : trainingType?.name,
    notes: group.name,
    ...(params.activity ? { isSpecialActivity: true, ...(params.activity.description ? { description: params.activity.description } : {}) } : {}),
    isWaitlistEnabled: false,
    waitlist: [],
    isPrivate: true,
    allowedMemberIds: memberIds,
    groupId: params.groupId,
    ...(params.trainingTypeId ? { trainingTypeId: params.trainingTypeId } : {}),
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

async function scanAll(input: ScanCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ ...input, ExclusiveStartKey: lastKey }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Same active-membership-window gate createSessionInstance() applies. */
export function hasActiveForcaMembership(profile: Pick<MemberProfileItem, 'membership'>, at: number = Date.now()): boolean {
  const start = typeof profile.membership?.start === 'string' ? new Date(profile.membership.start).getTime() : NaN;
  const end = typeof profile.membership?.end === 'string' ? new Date(profile.membership.end).getTime() : NaN;
  return !Number.isNaN(start) && !Number.isNaN(end) && at >= start && at <= end;
}

/**
 * Registers a member onto every not-yet-occurred ClassItem of `groupId` she
 * isn't already on — exactly as if she'd been in the group (with an active
 * membership) when each one was materialized. Callers apply the membership
 * gate themselves. Used by adminAssignGroup.ts (joining a group) and
 * adminGrantForcaMembership.ts (membership granted after she was already in
 * the group — without this, sessions created while she had no membership
 * never pick her up). Returns how many sessions she was added to.
 */
export async function registerMemberOnFutureGroupSessions(memberId: string, groupId: string): Promise<number> {
  const nowIso = new Date().toISOString();
  // groupId isn't indexed — same accepted Scan tradeoff as
  // adminSaveRecurringSession.ts's future-instance patch.
  const futureClasses = (await scanAll({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'SK = :meta AND groupId = :gid AND #dt >= :now',
    ExpressionAttributeNames: { '#dt': 'date' },
    ExpressionAttributeValues: { ':meta': 'METADATA', ':gid': groupId, ':now': nowIso },
  })) as unknown as ClassItem[];

  let added = 0;
  await Promise.all(futureClasses.map(async (cls) => {
    if ((cls.allowedMemberIds ?? []).includes(memberId)) return;
    const classId = cls.PK.replace('CLASS#', '');

    await Promise.all([
      ddb.send(new PutCommand({
        TableName: FORCA_TABLE_NAME,
        Item: {
          PK: cls.PK, SK: `REG#${memberId}`,
          GSI1PK: `MEMBER#${memberId}`, GSI1SK: `REG##${classId}`,
          userId: memberId,
          classId,
          classDate: cls.date,
          status: 'REGISTERED',
          consumedFrom: 'FORCA_AUTO',
          membershipId: '',
          targetMonth: '',
          declaredAttendance: 'pending',
          actualAttendance: null,
          registeredAt: nowIso,
        },
      })),
      ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: { PK: cls.PK, SK: 'METADATA' },
        // capacity is a DynamoDB reserved keyword — bare here it fails every call.
        UpdateExpression: 'SET allowedMemberIds = :ids ADD #capacity :one, currentAttendeesCount :one',
        ExpressionAttributeNames: { '#capacity': 'capacity' },
        ExpressionAttributeValues: {
          ':ids': [...(cls.allowedMemberIds ?? []), memberId],
          ':one': 1,
        },
      })),
    ]);
    added += 1;
  }));
  return added;
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
export async function deleteSessionInstance(classId: string, options: { keepPlanCopy?: boolean } = {}): Promise<void> {
  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
  }));
  const regs = (regsRes.Items ?? []) as { SK: string }[];
  await Promise.all(regs.map((r) =>
    ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: r.SK } })),
  ));
  const deleted = await ddb.send(new DeleteCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
    ReturnValues: 'ALL_OLD',
  }));
  const session = deleted.Attributes as ClassItem | undefined;
  if (!options.keepPlanCopy && session?.planOverride && session.workoutPlanId) await deletePlanCopy(session.workoutPlanId);
}

/**
 * Deletes a session's private plan copy (see WorkoutPlanItem.sessionCopyOf).
 * Refuses anything that isn't one: a library plan's partition is never
 * deleted from here, however this got called.
 */
export async function deletePlanCopy(planId: string): Promise<void> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${planId}` },
  }));
  const items = (res.Items ?? []) as { PK: string; SK: string; sessionCopyOf?: string }[];
  if (!items.find((i) => i.SK === 'METADATA')?.sessionCopyOf) return;
  await Promise.all(items.map((i) => ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: i.PK, SK: i.SK } }))));
}

/**
 * Every not-yet-occurred ClassItem generated from `recurringSessionId` —
 * used both by adminSaveRecurringSession.ts (pattern change ⇒ delete +
 * regenerate) and adminDeleteRecurringSession.ts (template removed ⇒ future
 * occurrences shouldn't happen either). Past instances are never touched —
 * they're the historical record getTrainingHistory.ts reads.
 */
export async function deleteFutureInstances(recurringSessionId: string, options: { keepPlanCopies?: boolean } = {}): Promise<number> {
  const items = await futureInstances(recurringSessionId);
  await Promise.all(items.map((item) => deleteSessionInstance(item.PK.replace('CLASS#', ''), { keepPlanCopy: options.keepPlanCopies })));
  return items.length;
}

async function futureInstances(recurringSessionId: string): Promise<ClassItem[]> {
  return (await scanAll({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'recurringSessionId = :rsid AND #dt >= :now',
    ExpressionAttributeNames: { '#dt': 'date' },
    ExpressionAttributeValues: { ':rsid': recurringSessionId, ':now': new Date().toISOString() },
  })) as unknown as ClassItem[];
}

/** The not-yet-occurred instances of a template that carry a per-session override. */
export async function futureOverriddenInstances(recurringSessionId: string): Promise<ClassItem[]> {
  return (await futureInstances(recurringSessionId)).filter((s) => s.planOverride || s.equipmentOverride);
}

// Half a week each way: a Tuesday session moved to Wednesday or Monday is still
// "that week's session", without ever reaching into the next one's week.
const OVERRIDE_CARRY_WINDOW_MS = 3.5 * 24 * 60 * 60 * 1000;

/**
 * Pairs each overridden session with the regenerated occurrence that replaces
 * it: the nearest one within OVERRIDE_CARRY_WINDOW_MS, each taken only once.
 * An override with no such occurrence (its week is gone from the schedule) is
 * returned in `lost`.
 */
export function matchOverridesToOccurrences<T extends { date: string }>(
  overridden: T[],
  created: { classId: string; date: string }[],
): { pairs: { from: T; toClassId: string }[]; lost: T[] } {
  const free = new Map(created.map((c) => [c.classId, new Date(c.date).getTime()]));
  const pairs: { from: T; toClassId: string }[] = [];
  const lost: T[] = [];
  for (const from of [...overridden].sort((a, b) => a.date.localeCompare(b.date))) {
    const at = new Date(from.date).getTime();
    let best: { classId: string; gap: number } | null = null;
    for (const [classId, when] of free) {
      const gap = Math.abs(when - at);
      if (gap <= OVERRIDE_CARRY_WINDOW_MS && (!best || gap < best.gap)) best = { classId, gap };
    }
    if (best) { free.delete(best.classId); pairs.push({ from, toClassId: best.classId }); }
    else lost.push(from);
  }
  return { pairs, lost };
}

/**
 * A template pattern change deletes and regenerates every future instance;
 * this moves each override onto its regenerated session so the edit survives.
 * Returns how many had nowhere to go (their private copies are deleted).
 */
export async function carrySessionOverrides(
  overridden: ClassItem[],
  created: { classId: string; date: string }[],
  template: { workoutPlanId?: string; workoutPlanName?: string },
): Promise<number> {
  const { pairs, lost } = matchOverridesToOccurrences(overridden, created);
  await Promise.all(pairs.map(async ({ from, toClassId }) => {
    const sets: string[] = [];
    const removes: string[] = [];
    const values: Record<string, unknown> = {};
    if (from.equipmentOverride) { sets.push('equipmentOverride = :equipment'); values[':equipment'] = from.equipmentOverride; }
    if (from.sessionEditLog) { sets.push('sessionEditLog = :log'); values[':log'] = from.sessionEditLog; }
    if (from.traineesNotifiedAt) { sets.push('traineesNotifiedAt = :notified'); values[':notified'] = from.traineesNotifiedAt; }
    if (from.planOverride && from.workoutPlanId) {
      sets.push('workoutPlanId = :planId', 'workoutPlanName = :planName', 'planOverride = :override');
      values[':planId'] = from.workoutPlanId;
      values[':planName'] = from.workoutPlanName;
      values[':override'] = rebasePlanOverride(from.planOverride, template);
      // A session is a plan OR a test session, and the edited plan wins here.
      removes.push('isTestSession', 'testGroupId', 'testGroupName', 'testComponentIds');
      if (from.isRunningSession) { sets.push('isRunningSession = :isRunning'); values[':isRunning'] = true; }
      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: { PK: `WORKOUTPLAN#${from.workoutPlanId}`, SK: 'METADATA' },
        UpdateExpression: 'SET sessionClassId = :classId',
        ExpressionAttributeValues: { ':classId': toClassId },
      }));
    }
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `CLASS#${toClassId}`, SK: 'METADATA' },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeValues: values,
    }));
  }));
  await Promise.all(lost.map((s) => (s.planOverride && s.workoutPlanId ? deletePlanCopy(s.workoutPlanId) : Promise.resolve())));
  return lost.length;
}

/** "Reset to original" follows the template: its current plan, when it has one. */
export function rebasePlanOverride(
  override: NonNullable<ClassItem['planOverride']>,
  template: { workoutPlanId?: string; workoutPlanName?: string },
): NonNullable<ClassItem['planOverride']> {
  if (!template.workoutPlanId) return override;
  return { ...override, basePlanId: template.workoutPlanId, basePlanName: template.workoutPlanName ?? override.basePlanName };
}
