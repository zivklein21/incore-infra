// FORCA admin cancel (Backoffice → subscription → ביטול מנוי). Only an admin
// (Or) uses it. She picks how the subscription ends:
//   now         "עכשיו – פעיל עד סוף החודש": runs at once. Token deleted now,
//               nothing charged again, the trainee keeps what was paid for
//               (the end of the month that was charged).
//   period_end  "בסוף התקופה הנוכחית": the exit point — the day after the
//               current activity period ends. Not offered between periods
//               (nothing is charged then; `now` does the same).
//   date        "בתאריך שאבחר": a day Or picks (tomorrow or later).
//
// One rule behind all three: the stop day is the first day nothing is
// charged. The daily charge job runs due stops before it charges anything
// (also outside periods), so a charge falling on the stop day itself is not
// made. The trainee stays active until the end of the last charged month.
// The stop day is fixed when it's saved: later period edits don't move it.
//
// Refunds are never automatic: Or decides them by hand (partial credit).
// Everything here is pure; store.ts does IO.

import type { ForcaAgreementStatus, ForcaStopMode } from '../entities';
import { addDays, currentPeriodEnd, firstOfNextMonthDay, isChargeDay, isDay, longDay, simulateChargeDays, type ActivityPeriod } from '../forcaPeriods/rules';

export const STOP_MODES: ForcaStopMode[] = ['now', 'period_end', 'date'];
export const MAX_REASON = 500;
export const MAX_REQUEST_ID = 100;
/** Furthest stop day Or can pick: two years ahead. */
export const MAX_DAYS_AHEAD = 731;

/** Last day of the month `day` is in. */
export function endOfMonthDay(day: string): string {
  return addDays(firstOfNextMonthDay(day), -1);
}

/** "MM/YYYY" — how a month reads in the summary. */
export function monthLabel(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return `${m}/${y}`;
}

/** No day of the month `day` is in falls inside a period. */
export function monthOutsidePeriods(periods: ActivityPeriod[], day: string): boolean {
  const first = `${day.slice(0, 7)}-01`;
  const last = endOfMonthDay(day);
  return !periods.some((p) => p.start <= last && p.end >= first);
}

export type StopWarning = { code: string; message: string };

export type StopPreview = {
  mode: ForcaStopMode;
  stopDay: string;
  /** Charges still made before the stop day. */
  remainingCharges: { day: string; amount: number }[];
  remainingTotal: number;
  /** Last day the trainee is active, or null if she isn't active now and won't be charged again. */
  lastActiveDay: string | null;
  /** Day the card token is deleted (= the stop day). */
  cardDeletedOn: string;
  warnings: StopWarning[];
  refundNote: string;
};

export type StopInput = {
  mode: unknown;
  stopDay?: unknown;
  today: string;
  periods: ActivityPeriod[];
  status: ForcaAgreementStatus;
  /** The stored nextChargeDate as an Israel day; null when none. */
  dueDay: string | null;
  amount: number;
  /** profile.membership.end as an Israel day; null when none. */
  membershipEnd: string | null;
};

export type StopResult = { ok: true; value: StopPreview } | { ok: false; error: string };

export const REFUND_NOTE = 'אין החזר אוטומטי. החזר יחסי, אם בכלל, נעשה ידנית בזיכוי חלקי.';

/** Works out the stop day, the remaining charges, the last active day and the warnings. */
export function previewStop(input: StopInput): StopResult {
  const { today, periods, status, dueDay, amount, membershipEnd } = input;
  const mode = STOP_MODES.includes(input.mode as ForcaStopMode) ? input.mode as ForcaStopMode : null;
  if (!mode) return { ok: false, error: 'invalid_mode' };
  if (status === 'cancelled') return { ok: false, error: 'already_cancelled' };
  // A subscription the charge job gave up on has nothing left to charge.
  if (status === 'failed' && mode !== 'now') return { ok: false, error: 'only_now_when_failed' };

  let stopDay: string;
  if (mode === 'now') {
    stopDay = today;
  } else if (mode === 'period_end') {
    const end = currentPeriodEnd(periods, today);
    if (!end) return { ok: false, error: 'no_current_period' };
    stopDay = addDays(end, 1);
  } else {
    if (!isDay(input.stopDay)) return { ok: false, error: 'invalid_stop_day' };
    if (input.stopDay <= today) return { ok: false, error: 'stop_day_not_in_future' };
    if (input.stopDay > addDays(today, MAX_DAYS_AHEAD)) return { ok: false, error: 'stop_day_too_far' };
    stopDay = input.stopDay;
  }

  const remainingCharges = mode !== 'now' && status === 'active' && dueDay
    ? simulateChargeDays(periods, dueDay, today, addDays(stopDay, -1)).map((day) => ({ day, amount }))
    : [];
  const remainingTotal = remainingCharges.reduce((sum, c) => sum + c.amount, 0);

  const lastCharge = remainingCharges.length ? remainingCharges[remainingCharges.length - 1].day : null;
  const paidThrough = lastCharge ? endOfMonthDay(lastCharge) : membershipEnd;
  const lastActiveDay = paidThrough && paidThrough >= today ? paidThrough : null;

  const warnings: StopWarning[] = [];
  if (status === 'frozen') {
    warnings.push({ code: 'frozen', message: 'המנוי מוקפא: אין חיובים כל עוד הוא מוקפא. אם יופשר לפני מועד העצירה, החיובים יחזרו עד אז.' });
  }
  if (mode === 'date' && !isChargeDay(periods, stopDay)) {
    warnings.push({
      code: monthOutsidePeriods(periods, stopDay) ? 'month_outside_period' : 'day_outside_period',
      message: monthOutsidePeriods(periods, stopDay)
        ? `החודש ${monthLabel(stopDay)} כולו מחוץ לתקופת פעילות.`
        : `התאריך ${longDay(stopDay)} מחוץ לתקופת פעילות.`,
    });
  }
  // The trainee is active until the end of the stop day's month only if that month was charged.
  if (mode !== 'now' && lastActiveDay !== endOfMonthDay(stopDay)) {
    warnings.push({
      code: 'stop_month_not_charged',
      message: lastActiveDay
        ? `החודש ${monthLabel(stopDay)} לא יחויב, ולכן הפעילות מסתיימת ב-${longDay(lastActiveDay)} ולא בסוף החודש.`
        : `החודש ${monthLabel(stopDay)} לא יחויב, והמנוי אינו פעיל כרגע.`,
    });
  }
  if (mode === 'now' && lastActiveDay !== endOfMonthDay(today)) {
    warnings.push({
      code: 'this_month_not_charged',
      message: lastActiveDay
        ? `החודש הנוכחי לא חויב: הפעילות מסתיימת ב-${longDay(lastActiveDay)}.`
        : 'החודש הנוכחי לא חויב: המנוי אינו פעיל כבר עכשיו.',
    });
  }

  return {
    ok: true,
    value: { mode, stopDay, remainingCharges, remainingTotal, lastActiveDay, cardDeletedOn: stopDay, warnings, refundNote: REFUND_NOTE },
  };
}

/** Reason (required) and the optional parent-request link. */
export function validateStopDetails(body: Record<string, unknown>): { ok: true; reason: string; parentRequestId?: string } | { ok: false; error: string } {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 2) return { ok: false, error: 'reason_required' };
  if (reason.length > MAX_REASON) return { ok: false, error: 'reason_too_long' };
  const raw = body.parentRequestId;
  if (raw === undefined || raw === null || raw === '') return { ok: true, reason };
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > MAX_REQUEST_ID) return { ok: false, error: 'invalid_parent_request_id' };
  return { ok: true, reason, parentRequestId: raw.trim() };
}

/** Whether a stop scheduled for `stopDay` has to run on `today` (or already should have). */
export const stopIsDue = (stopDay: string | undefined, today: string) => !!stopDay && stopDay <= today;
