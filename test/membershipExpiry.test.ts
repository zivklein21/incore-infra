// Run: npm test
// INCORE membership expiry and purchase windows (lib/membershipExpiry.ts),
// incl. memberships bought near midnight and on the last day of a month.
// Pure functions only, no DynamoDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEANUP_LOOKBACK_MS, coversAt, coversClassDate, EXPIRY_PUSH_BODY, firstRecurringChargeDate, isActiveAt, lastDayOf, membershipEndsAt,
  needsBookingCleanup, pickCurrentMembership, RENEWAL_GRACE_MS, shouldSupersede, subscriptionPurchaseWindow, sweepAction,
  paidByMembership, expiryPushBody, EXPIRY_PUSH_BODY_NO_BOOKINGS, DECLINE_PUSH_BODY, declineAction,
} from '../src/lib/membershipExpiry';
import { auditEntry, diffFields } from '../src/lib/membershipAudit';
import { bookingMembership, membershipForClass } from '../src/lib/registrationMembership';
import { israelDateStr, type MembershipItem } from '../src/lib/entities';

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();
const nov = { targetMonth: '2026-11', status: 'ACTIVE', startDate: '2026-10-31T22:00:00.000Z', endDate: '2026-11-30T21:59:59.999Z' };
const NOV_ENDS = '2026-11-30T22:00:00.000Z'; // 00:00 Dec 1, Israel (winter, UTC+2)

// ── When a membership ends ───────────────────────────────────────────────

test('all three stored endDate shapes end at 00:00 Israel after the last day', () => {
  for (const endDate of ['2026-11-30T21:59:59.999Z', '2026-11-30T23:59:59.999Z', '2026-11-30T23:59:59.000Z']) {
    assert.equal(lastDayOf(endDate), '2026-11-30', endDate);
    assert.equal(iso(membershipEndsAt({ targetMonth: '2026-11', endDate })), NOV_ENDS, endDate);
  }
});

test('summer time: the last day ends at 21:00 UTC', () => {
  for (const endDate of ['2026-07-31T20:59:59.999Z', '2026-07-31T23:59:59.999Z']) {
    assert.equal(iso(membershipEndsAt({ targetMonth: '2026-07', endDate })), '2026-07-31T21:00:00.000Z');
  }
});

test('an October membership ends at the right hour across the DST change (Oct 25)', () => {
  assert.equal(iso(membershipEndsAt({ targetMonth: '2026-10', endDate: '2026-10-31T21:59:59.999Z' })), '2026-10-31T22:00:00.000Z');
  assert.equal(iso(membershipEndsAt({ targetMonth: '2026-10', endDate: '2026-10-31T23:59:59.999Z' })), '2026-10-31T22:00:00.000Z');
});

test('a mid-month custom end date ends that night, not two hours later', () => {
  assert.equal(iso(membershipEndsAt({ targetMonth: '2026-09', endDate: '2026-09-26T23:59:59.000Z' })), '2026-09-26T21:00:00.000Z');
});

test('no endDate: the end of the month it is filed under', () => {
  assert.equal(iso(membershipEndsAt({ targetMonth: '2026-11' })), NOV_ENDS);
  assert.equal(iso(membershipEndsAt({ targetMonth: '2026-12' })), '2026-12-31T22:00:00.000Z');
});

test('active right up to the end of the last day, not a millisecond after', () => {
  assert.equal(isActiveAt(nov, at('2026-11-30T21:59:59.999Z')), true); // 23:59:59.999 Nov 30, Israel
  assert.equal(isActiveAt(nov, at(NOV_ENDS)), false);
  assert.equal(isActiveAt({ ...nov, status: 'EXPIRED' }, at('2026-11-15T10:00:00Z')), false);
});

// ── The hourly sweep ─────────────────────────────────────────────────────

test('sweep: a non-renewing membership expires at the end of its last day', () => {
  assert.equal(sweepAction(nov, at('2026-11-30T21:59:59.999Z'), false), 'none');
  assert.equal(sweepAction(nov, at(NOV_ENDS), false), 'expire');
  assert.equal(sweepAction({ ...nov, endDate: '2026-11-30T23:59:59.999Z' }, at('2026-11-30T22:05:00Z'), false), 'expire');
});

test('sweep: auto-renewing with an active agreement waits for the 03:00 charge', () => {
  const auto = { ...nov, isAutoRenew: true };
  assert.equal(sweepAction(auto, at('2026-11-30T22:05:00Z'), true), 'renewal_grace'); // 00:05 Dec 1
  assert.equal(sweepAction(auto, at('2026-12-01T01:05:00Z'), true), 'renewal_grace'); // 03:05, charge retried tomorrow
  assert.equal(sweepAction(auto, new Date(new Date(NOV_ENDS).getTime() + RENEWAL_GRACE_MS), true), 'expire');
});

test('sweep: auto-renew flag but no active agreement (cancelled, paused) expires on time', () => {
  // Idit's October membership: agreement cancelled 5/10, stayed ACTIVE until 7/11.
  const idit = { targetMonth: '2026-10', status: 'ACTIVE', isAutoRenew: true, endDate: '2026-10-31T23:59:59.999Z' };
  assert.equal(sweepAction(idit, at('2026-10-31T22:05:00Z'), false), 'expire');
});

test('sweep: never touches PENDING (new member not yet paid / future-dated admin grant)', () => {
  const pending = { targetMonth: '2026-11', status: 'PENDING', startDate: '2026-11-01T22:00:00.000Z', endDate: '2026-11-30T21:59:59.999Z' };
  assert.equal(sweepAction(pending, at('2026-11-15T10:00:00Z'), false), 'none');
  assert.equal(sweepAction(pending, at('2027-01-01T00:00:00Z'), false), 'none');
});

test('sweep: next month bought early (ACTIVE, future start) is left alone', () => {
  const dec = { targetMonth: '2026-12', status: 'ACTIVE', startDate: NOV_ENDS, endDate: '2026-12-31T21:59:59.999Z' };
  assert.equal(sweepAction(dec, at('2026-11-20T10:00:00Z'), false), 'none');
});

test('sweep: leaves closed statuses alone, any casing', () => {
  for (const status of ['EXPIRED', 'expired', 'CANCELLED', 'past_due', 'PENDING']) {
    assert.equal(sweepAction({ ...nov, status }, at('2027-01-01T00:00:00Z'), false), 'none', status);
  }
});

// ── Buying near midnight and on the last day of the month ────────────────

test('regression (Idit 7/11 23:12): last month still ACTIVE by status does not push the purchase to next month', () => {
  const now = at('2026-11-07T21:12:23.544Z');
  const october = { targetMonth: '2026-10', status: 'ACTIVE', endDate: '2026-10-31T23:59:59.999Z' };
  const w = subscriptionPurchaseWindow(now, isActiveAt(october, now));
  assert.equal(w.targetMonth, '2026-11');
  assert.equal(iso(w.start), '2026-11-06T22:00:00.000Z'); // 00:00 Nov 7, Israel
  assert.equal(israelDateStr(w.end), '2026-11-30');
});

test('bought at 23:59 on the last day with no membership: that day, that month', () => {
  const now = at('2026-11-30T21:59:00Z'); // 23:59 Nov 30, Israel
  const w = subscriptionPurchaseWindow(now, false);
  assert.equal(w.targetMonth, '2026-11');
  assert.equal(israelDateStr(w.start), '2026-11-30');
  assert.equal(iso(membershipEndsAt({ targetMonth: w.targetMonth, endDate: iso(w.end) })), NOV_ENDS);
});

test('bought at 23:59 on the last day while this month is running: next month', () => {
  const now = at('2026-11-30T21:59:00Z');
  const w = subscriptionPurchaseWindow(now, isActiveAt(nov, now));
  assert.equal(w.targetMonth, '2026-12');
  assert.equal(iso(w.start), NOV_ENDS);
});

test('bought at 00:01 on the 1st with last month still ACTIVE by status: the new month, from today', () => {
  const now = at('2026-11-30T22:01:00Z'); // 00:01 Dec 1, Israel; 22:01 Nov 30 UTC
  const w = subscriptionPurchaseWindow(now, isActiveAt(nov, now));
  assert.equal(w.targetMonth, '2026-12');
  assert.equal(iso(w.start), NOV_ENDS);
  assert.equal(israelDateStr(w.end), '2026-12-31');
});

test('bought at 01:30 Israel on the 1st (still the previous day in UTC) belongs to the new month', () => {
  const now = at('2026-11-30T23:30:00Z');
  assert.equal(subscriptionPurchaseWindow(now, false).targetMonth, '2026-12');
});

test('summer: bought 23:30 on Jul 31 Israel (20:30 UTC) stays in July', () => {
  const w = subscriptionPurchaseWindow(at('2026-07-31T20:30:00Z'), false);
  assert.equal(w.targetMonth, '2026-07');
  assert.equal(iso(w.end), '2026-07-31T20:59:59.999Z');
});

test('December rolls into January', () => {
  const w = subscriptionPurchaseWindow(at('2026-12-31T21:30:00Z'), false); // 23:30 Dec 31, Israel
  assert.equal(w.targetMonth, '2026-12');
  assert.equal(subscriptionPurchaseWindow(at('2026-12-31T21:30:00Z'), true).targetMonth, '2027-01');
});

// ── The grant and the first recurring charge ─────────────────────────────

test('first recurring charge: the 1st after the period bought', () => {
  assert.equal(iso(firstRecurringChargeDate(at('2026-11-07T21:12:00Z'), '2026-11-06T22:00:00.000Z')), NOV_ENDS);
  // Bought December on Nov 20: December is paid, so the next charge is Jan 1, not Dec 1.
  assert.equal(iso(firstRecurringChargeDate(at('2026-11-20T10:00:00Z'), NOV_ENDS)), '2026-12-31T22:00:00.000Z');
  assert.equal(iso(firstRecurringChargeDate(at('2026-11-20T10:00:00Z'), undefined)), NOV_ENDS);
  assert.equal(iso(firstRecurringChargeDate(at('2026-11-30T21:59:00Z'), '2026-11-29T22:00:00.000Z')), NOV_ENDS); // 23:59 on the last day
});


test('supersede: the renewal replaces last month; buying next month early keeps this one running', () => {
  assert.equal(shouldSupersede(nov, '2026-12-01T01:00:00.000Z', at('2026-12-01T01:00:00Z')), true); // 03:00 charge on Dec 1
  assert.equal(shouldSupersede(nov, NOV_ENDS, at('2026-11-20T10:00:00Z')), false);
  const bridge = { targetMonth: '2026-11', status: 'ACTIVE', endDate: '2026-12-10T21:59:59.999Z' };
  assert.equal(shouldSupersede(bridge, NOV_ENDS, at('2026-11-20T10:00:00Z')), true); // overlaps
});

// ── Booking ──────────────────────────────────────────────────────────────

const mem = (over: Partial<MembershipItem>): MembershipItem => ({
  PK: 'MEMBER#m', SK: `MEMBERSHIP#${over.targetMonth}#${over.membershipId}`, membershipId: 'x', status: 'ACTIVE',
  targetMonth: '2026-11', monthlyLimit: 8, weeklyLimit: 2, isAutoRenew: false, ...over,
} as MembershipItem);

test('booking: an ACTIVE membership does not pay for a class after its last day', () => {
  const ends15 = mem({ membershipId: 'a', endDate: '2026-11-15T21:59:59.999Z' });
  assert.equal(coversClassDate(ends15, at('2026-11-15T16:00:00Z')), true);
  assert.equal(coversClassDate(ends15, at('2026-11-20T06:00:00Z')), false);
  assert.equal(membershipForClass([ends15], at('2026-11-15T16:00:00Z'), '2026-11', true)?.membershipId, 'a');
  assert.equal(membershipForClass([ends15], at('2026-11-20T06:00:00Z'), '2026-11', true), null);
});

test('booking ahead still uses this month\'s auto-renewing membership', () => {
  const current = mem({ membershipId: 'b', isAutoRenew: true, endDate: '2026-11-30T21:59:59.999Z' });
  assert.equal(membershipForClass([current], at('2026-12-03T06:00:00Z'), '2026-11', false)?.membershipId, 'b');
});

test('booking on the last evening of the month is covered', () => {
  const current = mem({ membershipId: 'c', endDate: '2026-11-30T23:59:59.999Z' });
  assert.equal(membershipForClass([current], at('2026-11-30T18:00:00Z'), '2026-11', true)?.membershipId, 'c'); // 20:00 Israel
});

// ── Booking ahead (auto-renew only) ──────────────────────────────────────

const NOW_NOV = at('2026-11-20T10:00:00Z');
const novAuto = mem({ membershipId: 'nov', isAutoRenew: true, startDate: '2026-10-31T22:00:00.000Z', endDate: '2026-11-30T21:59:59.999Z' });

test('booking ahead: auto-renew member books January as FUTURE, against this month — not blocked by the last-day rule', () => {
  for (const cls of ['2026-12-03T06:00:00Z', '2027-01-14T06:00:00Z']) {
    const r = bookingMembership([novAuto], at(cls), NOW_NOV);
    assert.equal(r.isFutureBooking, true, cls);
    assert.equal(r.treatAsFuture, true, cls);
    assert.equal(r.membership?.membershipId, 'nov', cls); // bookClass then requires isAutoRenew
  }
});

test('booking ahead: a member without auto-renew gets her membership back with isAutoRenew false (bookClass refuses)', () => {
  const manual = mem({ membershipId: 'man', isAutoRenew: false, endDate: '2026-11-30T21:59:59.999Z' });
  const r = bookingMembership([manual], at('2026-12-03T06:00:00Z'), NOW_NOV);
  assert.equal(r.treatAsFuture, true);
  assert.equal(r.membership?.isAutoRenew, false);
});

test('booking ahead: next month bought early pays for its own classes directly, not as FUTURE on this month', () => {
  const dec = mem({ membershipId: 'dec', targetMonth: '2026-12', isAutoRenew: true, startDate: NOV_ENDS, endDate: '2026-12-31T21:59:59.999Z' });
  const r = bookingMembership([novAuto, dec], at('2026-12-03T06:00:00Z'), NOW_NOV);
  assert.equal(r.membership?.membershipId, 'dec');
  assert.equal(r.treatAsFuture, false);
  // A November class still goes to November.
  assert.equal(bookingMembership([novAuto, dec], at('2026-11-25T06:00:00Z'), NOW_NOV).membership?.membershipId, 'nov');
});

test('booking this month after the membership\'s last day: no membership (punch cards only)', () => {
  const ends15 = mem({ membershipId: 'a', endDate: '2026-11-15T21:59:59.999Z' });
  const r = bookingMembership([ends15], at('2026-11-25T06:00:00Z'), NOW_NOV);
  assert.equal(r.membership, null);
  assert.equal(r.treatAsFuture, false);
});

test('a bridge running past its month still books into the next month as itself', () => {
  const bridge = mem({ membershipId: 'br', type: 'CUSTOM_MIGRATION', endDate: '2026-12-10T21:59:59.000Z' } as Partial<MembershipItem>);
  const r = bookingMembership([bridge], at('2026-12-03T06:00:00Z'), NOW_NOV);
  assert.equal(r.membership?.membershipId, 'br');
  assert.equal(r.treatAsFuture, false);
});

// ── Which membership is "current" ────────────────────────────────────────

test('current: with next month bought early (ACTIVE, future start), this month\'s is shown', () => {
  const novRec = { ...nov, createdAt: '2026-11-01T01:00:00Z' };
  const decRec = { targetMonth: '2026-12', status: 'ACTIVE', startDate: NOV_ENDS, endDate: '2026-12-31T21:59:59.999Z', createdAt: '2026-11-20T10:00:00Z' };
  assert.equal(pickCurrentMembership([decRec, novRec], NOW_NOV), novRec);
  assert.equal(pickCurrentMembership([decRec, novRec], at('2026-12-02T10:00:00Z')), decRec);
  assert.equal(coversAt(decRec, NOW_NOV), false);
});

test('current: only a future-start ACTIVE membership → shown as the plan (not "no active plan")', () => {
  const decRec = { targetMonth: '2026-12', status: 'ACTIVE', startDate: NOV_ENDS, endDate: '2026-12-31T21:59:59.999Z' };
  const oct = { targetMonth: '2026-10', status: 'EXPIRED', endDate: '2026-10-31T21:59:59.999Z', createdAt: '2026-10-01T00:00:00Z' };
  assert.equal(pickCurrentMembership([oct, decRec], NOW_NOV)?.status, 'ACTIVE');
});

test('current: PENDING (new member, not paid) keeps its old place — after ACTIVE, before lapsed', () => {
  const pending = { targetMonth: '2026-11', status: 'PENDING', createdAt: '2026-11-19T00:00:00Z' };
  const expired = { targetMonth: '2026-10', status: 'EXPIRED', createdAt: '2026-11-19T01:00:00Z' };
  assert.equal(pickCurrentMembership([expired, pending], NOW_NOV), pending);
  assert.equal(pickCurrentMembership([pending, { ...nov }], NOW_NOV)?.status, 'ACTIVE');
});

// ── When a membership really ends: cancel future bookings ────────────────

const novEnded = { ...nov, status: 'EXPIRED' };
const DEC1_0005 = at('2026-11-30T22:05:00Z');

test('cleanup: not renewed (no agreement) → future bookings cancelled at the end of the last day', () => {
  assert.equal(needsBookingCleanup([novEnded], at('2026-11-30T21:59:00Z'), false), false);
  assert.equal(needsBookingCleanup([{ ...nov }], DEC1_0005, false), true); // still ACTIVE by status, sweep expires it the same run
  assert.equal(needsBookingCleanup([novEnded], DEC1_0005, false), true);
});

test('cleanup: auto-renew waits through the 48h renewal grace, then cancels if still not renewed', () => {
  const auto = { ...novEnded, isAutoRenew: true };
  assert.equal(needsBookingCleanup([auto], DEC1_0005, true), false);
  assert.equal(needsBookingCleanup([auto], at('2026-12-02T01:30:00Z'), true), false); // after the retry charge
  assert.equal(needsBookingCleanup([auto], new Date(new Date(NOV_ENDS).getTime() + RENEWAL_GRACE_MS), true), true);
});

test('cleanup: renewed (or next month bought early) → nothing cancelled', () => {
  const dec = { targetMonth: '2026-12', status: 'ACTIVE', startDate: NOV_ENDS, endDate: '2026-12-31T21:59:59.999Z' };
  assert.equal(needsBookingCleanup([novEnded, dec], DEC1_0005, false), false);
});

test('cleanup: once only, never for old history, cancelled or PENDING', () => {
  assert.equal(needsBookingCleanup([{ ...novEnded, expiryCleanupAt: '2026-11-30T22:05:00Z' }], at('2026-11-30T23:05:00Z'), false), false);
  assert.equal(needsBookingCleanup([novEnded], new Date(new Date(NOV_ENDS).getTime() + CLEANUP_LOOKBACK_MS + 1), false), false);
  assert.equal(needsBookingCleanup([{ ...nov, status: 'CANCELLED' }], DEC1_0005, false), false);
  assert.equal(needsBookingCleanup([{ ...nov, status: 'PENDING' }], DEC1_0005, false), false);
});

test('cleanup cancels only bookings the membership paid for; credit, punch-card and trial bookings stay', () => {
  assert.equal(paidByMembership({ consumedFrom: 'MEMBERSHIP' }), true);
  assert.equal(paidByMembership({ consumedFrom: 'FUTURE_SUBSCRIPTION' }), true);
  for (const c of ['EXTRA_PUNCH', 'ADMIN_CARD', 'TRIAL', '']) assert.equal(paidByMembership({ consumedFrom: c }), false, c);
});

test('expiry push: always sent, text depends on whether bookings were cancelled', () => {
  assert.equal(expiryPushBody(2), 'המנוי שלך הסתיים וההרשמות העתידיות בוטלו. אפשר להירשם מחדש לאחר חידוש המנוי.');
  assert.equal(expiryPushBody(0), 'המנוי שלך הסתיים. אפשר לחדש אותו באפליקציה.');
  assert.equal(EXPIRY_PUSH_BODY_NO_BOOKINGS, expiryPushBody(0));
});

test('decline: first decline only notifies; expire after the retry fails too', () => {
  assert.equal(declineAction({ token: 't', consecutiveFailures: 0 }), 'notify');
  assert.equal(declineAction({ token: 't', consecutiveFailures: 1 }), 'expire');
  assert.equal(DECLINE_PUSH_BODY, 'החיוב החודשי נכשל. נא לעדכן אמצעי תשלום כדי לשמור על המנוי וההרשמות.');
});

test('decline with no card: notify once, never expire here (the renewal grace does)', () => {
  assert.equal(declineAction({ consecutiveFailures: 0 }), 'notify');
  assert.equal(declineAction({ consecutiveFailures: 0, noCardAdminNotified: true }), 'none');
});

test('decline: during the retry the membership is kept (renewal grace), and expired after the final decline', () => {
  const auto = { ...nov, isAutoRenew: true };
  // Dec 1 03:00 first decline → agreement still active: kept, bookings kept.
  assert.equal(sweepAction(auto, at('2026-12-01T01:05:00Z'), true), 'renewal_grace');
  assert.equal(needsBookingCleanup([auto], at('2026-12-01T01:05:00Z'), true), false);
  // Dec 2 03:00 retry declined → expired, agreement failed (not active) → cleanup next run.
  assert.equal(needsBookingCleanup([{ ...auto, status: 'EXPIRED' }], at('2026-12-02T01:05:00Z'), false), true);
});

// ── Admin audit trail ────────────────────────────────────────────────────

const by = { uid: 'admin1', name: 'Or Saraf' };

test('audit: an edit records who, when, and each changed field before → after', () => {
  const before = { status: 'ACTIVE', startDate: '2026-11-01T22:00:00.000Z', endDate: '2026-11-30T23:59:59.999Z', monthlyLimit: 8, usage: { totalMonthlyUsed: 3 } };
  const e = auditEntry(by, 'edited', 'adminSaveMemberSubscription', before,
    { status: 'ACTIVE', startDate: '2026-10-31T22:00:00.000Z', endDate: '2026-11-30T21:59:59.999Z', monthlyLimit: 8 }, {}, '2026-11-10T12:00:00Z');
  assert.equal(e.at, '2026-11-10T12:00:00Z');
  assert.deepEqual(e.by, by);
  assert.deepEqual(e.changes, ['startDate', 'endDate']);
  assert.deepEqual(e.diff, {
    startDate: { from: '2026-11-01T22:00:00.000Z', to: '2026-10-31T22:00:00.000Z' },
    endDate: { from: '2026-11-30T23:59:59.999Z', to: '2026-11-30T21:59:59.999Z' },
  });
});

test('audit: a create records every audited field from null; usage is not audited', () => {
  const e = auditEntry(by, 'created', 'adminGrantMembership', null, { status: 'ACTIVE', targetMonth: '2026-11', usage: {} });
  assert.deepEqual(e.diff, { status: { from: null, to: 'ACTIVE' }, targetMonth: { from: null, to: '2026-11' } });
  assert.equal(e.changes, undefined);
});

test('audit: unlinking a payment shows as value → null', () => {
  assert.deepEqual(diffFields({ paymentOrderId: 'o1' }, { paymentOrderId: null }), { paymentOrderId: { from: 'o1', to: null } });
});
