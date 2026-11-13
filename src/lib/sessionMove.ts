import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import { israelDateStr } from './entities';

// Moving a session (ClassItem) to another date — both brands. Every path that
// changes a ClassItem's `date` must keep two denormalized copies in step:
//
//   1. The day index: GSI2PK = CLASSDATE#<Israel day of `date`>. The coach
//      calendar (getCoachSessions), INCORE's schedule (getClasses), class
//      reminders (classReminderEngine), the forms activity picker
//      (adminListActivities) and bookClass's same-day check all query by day,
//      so a stale GSI2PK shows the session on its OLD day and hides it on the
//      new one.
//   2. Each registration's `classDate` (REG# items), read by group
//      reassignment (adminAssignGroup), membership-expiry cleanup and history
//      paging to tell future bookings from past ones.
//
// The registrations themselves (roster, status, credits), the class's counts
// and form assignments live under CLASS#<id> or point at the classId, so they
// move with it untouched. targetMonth/weekKey on INCORE registrations are the
// booking's accounting record (which month's credit paid) and are kept.
//
// Writers: updateClass.ts + saveClassSeries.ts (INCORE), adminUpdateSessionInstance.ts
// (FORCA). FORCA recurring edits that change the pattern regenerate instances
// via createSessionInstance (fresh keys); the other series edits never move a date.

/** The day-index keys for a session on `date`. */
export const dayIndexKeys = (classId: string, date: Date) => ({
  GSI2PK: `CLASSDATE#${israelDateStr(date)}`,
  GSI2SK: `CLASS#${classId}`,
});

/** True when a stored session's day index doesn't match its date (the bug scripts/checkSessionDayIndex.ts finds). */
export function dayIndexMismatch(item: { PK?: unknown; date?: unknown; GSI2PK?: unknown; GSI2SK?: unknown }): { expected: { GSI2PK: string; GSI2SK: string } } | null {
  if (typeof item.date !== 'string' || typeof item.PK !== 'string' || !item.PK.startsWith('CLASS#')) return null;
  const date = new Date(item.date);
  if (Number.isNaN(date.getTime())) return null;
  const expected = dayIndexKeys(item.PK.slice('CLASS#'.length), date);
  return item.GSI2PK === expected.GSI2PK && item.GSI2SK === expected.GSI2SK ? null : { expected };
}

/**
 * After a session's date changed: every registration gets the new classDate.
 * When it moved to another day, a reminder already sent for the old day is
 * cleared so the reminder engine sends one for the new day. Returns how many
 * registrations were updated.
 */
export async function syncRegistrationsAfterMove(table: string, classId: string, from: Date, to: Date): Promise<number> {
  if (from.getTime() === to.getTime()) return 0;
  const dayChanged = israelDateStr(from) !== israelDateStr(to);
  const regs: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
      ExclusiveStartKey: lastKey,
    }));
    regs.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const resetReminder = dayChanged && to.getTime() > Date.now();
  await Promise.all(regs.map(r => ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: r.PK, SK: r.SK },
    UpdateExpression: `SET classDate = :d${resetReminder && r.reminderSent ? ' REMOVE reminderSent, reminderSentAt' : ''}`,
    ExpressionAttributeValues: { ':d': to.toISOString() },
  }))));
  return regs.length;
}

export interface DayIndexRepair {
  classId: string;
  className: string;
  /** The session's real date and Israel day. */
  date: string;
  day: string;
  /** Where the day index currently files it (the "old day" it still shows on), or null if missing. */
  indexedDay: string | null;
  /** Set when the class item's GSI2PK/GSI2SK must be rewritten. */
  fixIndex: { GSI2PK: string; GSI2SK: string } | null;
  /** Registrations whose classDate isn't the session's date. */
  staleRegistrations: { PK: string; SK: string; classDate: string | null; status: string; clearReminder: boolean }[];
}

/**
 * From a scan of one table's CLASS# items (METADATA + REG#), what a repair
 * would change — read-only. Sessions without a date, and registrations of a
 * session that's gone, are left alone. A future session moved to another day
 * also gets a reminder already sent for its old day cleared (same rule as
 * syncRegistrationsAfterMove).
 */
export function planDayIndexRepairs(items: Record<string, unknown>[], now = Date.now()): DayIndexRepair[] {
  const byClass = new Map<string, { meta?: Record<string, unknown>; regs: Record<string, unknown>[] }>();
  for (const item of items) {
    const pk = String(item.PK ?? '');
    if (!pk.startsWith('CLASS#')) continue;
    const entry = byClass.get(pk) ?? { regs: [] };
    if (item.SK === 'METADATA') entry.meta = item;
    else if (String(item.SK ?? '').startsWith('REG#')) entry.regs.push(item);
    byClass.set(pk, entry);
  }
  const out: DayIndexRepair[] = [];
  for (const [pk, { meta, regs }] of byClass) {
    if (!meta || typeof meta.date !== 'string') continue;
    const date = new Date(meta.date);
    if (Number.isNaN(date.getTime())) continue;
    const mismatch = dayIndexMismatch(meta);
    const day = israelDateStr(date);
    const stale = regs
      .filter(r => typeof r.classDate !== 'string' || new Date(r.classDate).getTime() !== date.getTime())
      .map(r => {
        const old = typeof r.classDate === 'string' ? new Date(r.classDate) : null;
        const movedDay = !old || Number.isNaN(old.getTime()) || israelDateStr(old) !== day;
        return {
          PK: String(r.PK), SK: String(r.SK), classDate: typeof r.classDate === 'string' ? r.classDate : null, status: String(r.status ?? ''),
          clearReminder: movedDay && date.getTime() > now && r.reminderSent === true,
        };
      });
    if (!mismatch && !stale.length) continue;
    out.push({
      classId: pk.slice('CLASS#'.length),
      className: typeof meta.className === 'string' ? meta.className : '',
      date: meta.date,
      day,
      indexedDay: typeof meta.GSI2PK === 'string' ? meta.GSI2PK.replace(/^CLASSDATE#/, '') : null,
      fixIndex: mismatch ? mismatch.expected : null,
      staleRegistrations: stale,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
