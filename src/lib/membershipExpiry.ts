import { endOfMonth, firstOfNextMonth, israelDateStr, israelDayStart, israelWallTimeToDate, monthKey } from './entities';

// When an INCORE membership (MembershipItem) stops being live, which one is
// "current", and what happens to bookings when one really ends. Pure
// functions only (unit-tested in test/membershipExpiry.test.ts);
// expireMemberships.ts and lib/membershipExpiryCleanup.ts do the writes.
//
// Statuses: a paid membership is only ever ACTIVE or EXPIRED (CANCELLED by an
// admin). PENDING belongs to the existing new-member / future-dated admin
// grant flow (activatePendingMemberships) and is left alone here. A
// membership bought for next month is ACTIVE with a future startDate; dates,
// not status, decide whether it covers today or a given class.
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

/** Only memberships that ended this recently are checked for booking cleanup, so old history is never touched. */
export const CLEANUP_LOOKBACK_MS = 7 * 24 * 3600_000;

export type MembershipDates = { status?: string; startDate?: string; endDate?: string; targetMonth: string; isAutoRenew?: boolean };

const statusOf = (m: { status?: string }) => (m.status ?? 'ACTIVE').toUpperCase();

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

/** The instant it starts (its start date, or the 1st of the month it's filed under). */
export function membershipStartsAt(m: Pick<MembershipDates, 'startDate' | 'targetMonth'>): Date {
  if (m.startDate) return new Date(m.startDate);
  const [y, mo] = m.targetMonth.split('-').map(Number);
  return israelWallTimeToDate(y, mo - 1, 1, 0, 0);
}

/** ACTIVE and not yet past its end (a future start counts) — what "has a membership" means at checkout. */
export function isActiveAt(m: MembershipDates, now: Date): boolean {
  return statusOf(m) === 'ACTIVE' && now.getTime() < membershipEndsAt(m).getTime();
}

/** ACTIVE and its dates cover `at`. */
export function coversAt(m: MembershipDates, at: Date): boolean {
  return isActiveAt(m, at) && membershipStartsAt(m).getTime() <= at.getTime();
}

export type SweepAction = 'expire' | 'renewal_grace' | 'none';

/**
 * What the hourly sweep does with one membership. Only ACTIVE ones are
 * touched. hasActiveRenewal: the member has an `active` subscription billing
 * agreement, so the 03:00 charge on the 1st will replace this membership —
 * until then it isn't expired, for at most RENEWAL_GRACE_MS.
 */
export function sweepAction(m: MembershipDates, now: Date, hasActiveRenewal: boolean): SweepAction {
  if (statusOf(m) !== 'ACTIVE') return 'none';
  const endsAt = membershipEndsAt(m).getTime();
  const t = now.getTime();
  if (t < endsAt) return 'none';
  if (m.isAutoRenew === true && hasActiveRenewal && t < endsAt + RENEWAL_GRACE_MS) return 'renewal_grace';
  return 'expire';
}

/**
 * The membership to show as the member's current one: the ACTIVE one that
 * covers `at` (today, or a class date); else the next ACTIVE one still to
 * come (bought for next month); else an ACTIVE one not yet swept; then the
 * rest by the old priority (PENDING, PAST_DUE, CANCELLED, EXPIRED). Ties go
 * to the most recently created.
 */
export function pickCurrentMembership<T extends MembershipDates & { createdAt?: string }>(items: T[], at: Date): T | null {
  const STATUS_RANK: Record<string, number> = { ACTIVE: 3, PENDING: 4, PAST_DUE: 5, CANCELLED: 6, EXPIRED: 7 };
  const rank = (m: T): number => {
    if (coversAt(m, at)) return 0;
    if (isActiveAt(m, at)) return 1; // starts later
    return STATUS_RANK[statusOf(m)] ?? 99;
  };
  const sorted = [...items].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    if (rank(a) === 1) return membershipStartsAt(a).getTime() - membershipStartsAt(b).getTime(); // soonest first
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
  return sorted[0] ?? null;
}

/**
 * The window a subscription bought at `now` covers. A member who already has
 * a membership running buys the next month; otherwise it starts today.
 * `liveNow` must come from isActiveAt (dates, not just status): a stale ACTIVE
 * status on last month's membership pushed a November purchase into December
 * (Idit, 2026-11-07).
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

/**
 * Whether a new paid membership replaces an older ACTIVE one: when they
 * overlap, or the old one has already ended. One still running that ends
 * before the new one starts (next month bought early) runs to its own end.
 */
export function shouldSupersede(old: MembershipDates, newStartIso: string, now: Date): boolean {
  const oldEnds = membershipEndsAt(old).getTime();
  return oldEnds <= now.getTime() || oldEnds > new Date(newStartIso).getTime();
}

/** Booking for this month: an ACTIVE membership doesn't pay for a class after its last day. */
export function coversClassDate(m: Pick<MembershipDates, 'endDate' | 'targetMonth'>, classDate: Date): boolean {
  return !m.endDate || classDate.getTime() < membershipEndsAt(m).getTime();
}

// ── When a membership really ends ────────────────────────────────────────

/**
 * Whether a member's future bookings must be cancelled now, given every
 * membership she has. True when a recently ended paid membership exists
 * that hasn't been cleaned up yet, she holds no ACTIVE membership still to
 * run (current or bought ahead), and no renewal is pending (an active
 * agreement gets RENEWAL_GRACE_MS from the end — a declined first charge is
 * retried the next day).
 */
export function needsBookingCleanup(
  memberships: (MembershipDates & { expiryCleanupAt?: string })[],
  now: Date,
  hasActiveRenewal: boolean,
): boolean {
  const t = now.getTime();
  if (memberships.some((m) => isActiveAt(m, now))) return false;
  const ended = memberships.filter((m) => {
    const s = statusOf(m);
    if (s !== 'EXPIRED' && s !== 'ACTIVE') return false; // CANCELLED/PENDING/PAST_DUE: not this flow
    if (m.expiryCleanupAt) return false;
    const endsAt = membershipEndsAt(m).getTime();
    return endsAt <= t && t - endsAt <= CLEANUP_LOOKBACK_MS;
  });
  if (ended.length === 0) return false;
  const lastEnd = Math.max(...ended.map((m) => membershipEndsAt(m).getTime()));
  return !(hasActiveRenewal && t < lastEnd + RENEWAL_GRACE_MS);
}

/**
 * Whether an expired membership was paying for this booking: a session taken
 * from a membership (MEMBERSHIP) or booked ahead on one (FUTURE_SUBSCRIPTION).
 * Bookings paid with wallet credit or a punch card (EXTRA_PUNCH, ADMIN_CARD)
 * and trials stay. Cleanup only runs when she has no live membership left,
 * so every membership-paid future booking is one an expired membership paid
 * for (a FUTURE_SUBSCRIPTION booking can point at an earlier record in the
 * same renewal chain).
 */
export function paidByMembership(reg: { consumedFrom?: string }): boolean {
  return reg.consumedFrom === 'MEMBERSHIP' || reg.consumedFrom === 'FUTURE_SUBSCRIPTION';
}

export const PUSH_TITLE = 'INCORE';
/** Sent when a membership expires and bookings it paid for were cancelled. */
export const EXPIRY_PUSH_BODY = 'המנוי שלך הסתיים וההרשמות העתידיות בוטלו. אפשר להירשם מחדש לאחר חידוש המנוי.';
/** Sent when a membership expires with no bookings to cancel. */
export const EXPIRY_PUSH_BODY_NO_BOOKINGS = 'המנוי שלך הסתיים. אפשר לחדש אותו באפליקציה.';
/** Sent after the first declined monthly charge (the retry is the next day). */
export const DECLINE_PUSH_BODY = 'החיוב החודשי נכשל. נא לעדכן אמצעי תשלום כדי לשמור על המנוי וההרשמות.';

export function expiryPushBody(cancelledCount: number): string {
  return cancelledCount > 0 ? EXPIRY_PUSH_BODY : EXPIRY_PUSH_BODY_NO_BOOKINGS;
}

/**
 * A declined monthly renewal charge: 'expire' on the final decline (the
 * retry failed too — consecutiveFailures reaches 2), 'notify' on the first
 * one (push to update the card; the membership and bookings stay), and with
 * no card on file — no retry counter, the agreement just waits — 'notify'
 * once; expireMemberships expires it after the renewal grace.
 */
export function declineAction(a: { token?: string; consecutiveFailures: number; noCardAdminNotified?: boolean }): 'expire' | 'notify' | 'none' {
  if (!a.token) return a.noCardAdminNotified ? 'none' : 'notify';
  return a.consecutiveFailures + 1 >= 2 ? 'expire' : 'notify';
}
