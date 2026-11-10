import { endOfMonth, firstOfNextMonth, israelDateStr, israelDayStart, israelWallTimeToDate, monthKey } from './entities';

// When an INCORE membership (MembershipItem) stops being live, and the
// related purchase/renewal decisions. Pure functions only (unit-tested in
// test/membershipExpiry.test.ts); expireMemberships.ts and
// scripts/fixMembershipStatuses.ts do the writes.
//
// A membership ends at the end of its last day, Israel time. Stored endDates
// come in three shapes for the same "last day is the 30th":
//   2026-11-30T21:59:59.999Z  endOfMonth() (Israel 23:59:59.999, winter)
//   2026-11-30T23:59:59.999Z  older code / app pickers (UTC end of day = 01:59 Israel on the 1st)
//   2026-11-30T23:59:59.000Z  CUSTOM_MIGRATION grants
// Stepping back 3 hours before reading the Israel date puts all three on the
// 30th, so each one ends at 00:00 Israel on the 1st.

const LAST_DAY_SHIFT_MS = 3 * 3600_000;

/** How long an auto-renewing membership stays live past its end while its renewal charge runs (03:00 on the 1st, retried next day). */
export const RENEWAL_GRACE_MS = 48 * 3600_000;

export type MembershipDates = { status?: string; startDate?: string; endDate?: string; targetMonth: string; isAutoRenew?: boolean };

/** The Israel calendar day (YYYY-MM-DD) a stored endDate means as the last day. */
export function lastDayOf(endDateIso: string): string {
  return israelDateStr(new Date(new Date(endDateIso).getTime() - LAST_DAY_SHIFT_MS));
}

/** The instant the membership stops: 00:00 Israel on the day after its last day. */
export function membershipEndsAt(m: Pick<MembershipDates, 'endDate' | 'targetMonth'>): Date {
  if (!m.endDate) {
    // No endDate (old items): the end of the month it's filed under.
    const [y, mo] = m.targetMonth.split('-').map(Number);
    return israelWallTimeToDate(y, mo, 1, 0, 0);
  }
  const [y, mo, d] = lastDayOf(m.endDate).split('-').map(Number);
  return israelWallTimeToDate(y, mo - 1, d + 1, 0, 0);
}

export function isLiveStatus(status: string | undefined): boolean {
  const s = (status ?? 'ACTIVE').toUpperCase();
  return s === 'ACTIVE' || s === 'PENDING';
}

/** ACTIVE and not yet past its end — what "has a membership right now" means at checkout. */
export function isActiveAt(m: MembershipDates, now: Date): boolean {
  return (m.status ?? 'ACTIVE').toUpperCase() === 'ACTIVE' && now.getTime() < membershipEndsAt(m).getTime();
}

export type SweepAction = 'expire' | 'activate' | 'renewal_grace' | 'none';

/**
 * What the hourly sweep does with one membership.
 * hasActiveRenewal: the member has an `active` subscription billing
 * agreement, so the 03:00 charge on the 1st will replace this membership (or
 * expire it on a decline) — until then it isn't shown as expired, for at
 * most RENEWAL_GRACE_MS.
 */
export function sweepAction(m: MembershipDates, now: Date, hasActiveRenewal: boolean): SweepAction {
  const status = (m.status ?? 'ACTIVE').toUpperCase();
  if (status !== 'ACTIVE' && status !== 'PENDING') return 'none';
  const endsAt = membershipEndsAt(m).getTime();
  const t = now.getTime();
  if (t >= endsAt) {
    if (status === 'ACTIVE' && m.isAutoRenew === true && hasActiveRenewal && t < endsAt + RENEWAL_GRACE_MS) return 'renewal_grace';
    return 'expire';
  }
  if (status === 'PENDING' && m.startDate && new Date(m.startDate).getTime() <= t) return 'activate';
  return 'none';
}

/**
 * The window a subscription bought at `now` covers. A member who already has
 * a membership running right now buys the next month; otherwise it starts
 * today. `liveNow` must come from isActiveAt (dates, not just status): a
 * stale ACTIVE status on last month's membership pushed a November purchase
 * into December (Idit, 2026-11-07).
 */
export function subscriptionPurchaseWindow(now: Date, liveNow: boolean): { start: Date; end: Date; targetMonth: string } {
  const start = liveNow ? firstOfNextMonth(now) : israelDayStart(now);
  return { start, end: endOfMonth(start), targetMonth: monthKey(start) };
}

/** First recurring charge: the 1st after the purchased period starts, so a next-month purchase isn't charged twice for that month. */
export function firstRecurringChargeDate(now: Date, startDateIso: string | undefined): Date {
  const start = startDateIso ? new Date(startDateIso) : now;
  return firstOfNextMonth(isNaN(start.getTime()) || start < now ? now : start);
}

/** A membership whose dates start in the future is PENDING until then. */
export function initialStatus(startDateIso: string, now: Date): 'ACTIVE' | 'PENDING' {
  return new Date(startDateIso).getTime() > now.getTime() ? 'PENDING' : 'ACTIVE';
}

/**
 * Whether a new paid membership replaces an older live one. A membership
 * that is still running and ends before the new one starts (buying next
 * month early) keeps running to its own end.
 */
export function shouldSupersede(old: MembershipDates, newStartIso: string, now: Date): boolean {
  const oldEnds = membershipEndsAt(old).getTime();
  return oldEnds <= now.getTime() || oldEnds > new Date(newStartIso).getTime();
}

/** Booking: an ACTIVE membership doesn't pay for a class after its last day. */
export function coversClassDate(m: Pick<MembershipDates, 'endDate' | 'targetMonth'>, classDate: Date): boolean {
  return !m.endDate || classDate.getTime() < membershipEndsAt(m).getTime();
}
