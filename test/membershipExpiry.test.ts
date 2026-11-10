// Run: npm test
// INCORE membership expiry and purchase windows (lib/membershipExpiry.ts),
// incl. memberships bought near midnight and on the last day of a month.
// Pure functions only, no DynamoDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coversClassDate, firstRecurringChargeDate, initialStatus, isActiveAt, lastDayOf, membershipEndsAt,
  RENEWAL_GRACE_MS, shouldSupersede, subscriptionPurchaseWindow, sweepAction,
} from '../src/lib/membershipExpiry';
import { membershipForClass } from '../src/lib/registrationMembership';
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

test('sweep: PENDING activates on its start date, and expires if already over', () => {
  const pending = { targetMonth: '2026-12', status: 'PENDING', startDate: NOV_ENDS, endDate: '2026-12-31T21:59:59.999Z' };
  assert.equal(sweepAction(pending, at('2026-11-30T21:00:00Z'), false), 'none');
  assert.equal(sweepAction(pending, at('2026-11-30T22:05:00Z'), false), 'activate');
  assert.equal(sweepAction(pending, at('2027-01-01T00:00:00Z'), false), 'expire');
});

test('sweep: leaves closed statuses alone, any casing', () => {
  for (const status of ['EXPIRED', 'expired', 'CANCELLED', 'past_due']) {
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

test('a membership bought for next month is PENDING until it starts', () => {
  assert.equal(initialStatus(NOV_ENDS, at('2026-11-20T10:00:00Z')), 'PENDING');
  assert.equal(initialStatus('2026-11-19T22:00:00.000Z', at('2026-11-20T10:00:00Z')), 'ACTIVE');
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
