// Run: npm test
// INCORE profile bookings order/paging (lib/memberBookings.ts) and the admin
// subscription rules (lib/memberSubscriptions.ts). Pure functions only, no
// DynamoDB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareBookingsDesc, decodeBookingCursor, encodeBookingCursor, pageBookings } from '../src/lib/memberBookings';
import { overlaps, resolvePaymentLinks, samePlan, statusForWindow, windowOf } from '../src/lib/memberSubscriptions';
import type { MembershipItem } from '../src/lib/entities';

const row = (id: string, date: string) => ({ id, date: new Date(date).toISOString() });

test('bookings: newest first, ties broken by classId', () => {
  const rows = [row('a', '2026-10-01T08:00Z'), row('c', '2026-11-05T08:00Z'), row('b', '2026-11-05T08:00Z'), row('d', '2026-12-01T08:00Z')];
  rows.sort(compareBookingsDesc);
  assert.deepEqual(rows.map((r) => r.id), ['d', 'c', 'b', 'a']);
});

test('bookings: pages join up with no gaps or repeats', () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(`c${i}`, `2026-11-0${i + 1}T08:00Z`)).sort(compareBookingsDesc);
  const seen: string[] = [];
  let cursor: { date: string; id: string } | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const page = pageBookings(rows, 3, cursor);
    seen.push(...page.items.map((r) => r.id));
    if (!page.nextCursor) break;
    cursor = decodeBookingCursor(page.nextCursor);
  }
  assert.deepEqual(seen, rows.map((r) => r.id));
});

test('bookings: a booking added between pages does not shift page 2', () => {
  const rows = [row('x', '2026-11-03T08:00Z'), row('y', '2026-11-02T08:00Z'), row('z', '2026-11-01T08:00Z')];
  const first = pageBookings(rows, 2, null);
  const withNew = [row('new', '2026-12-01T08:00Z'), ...rows];
  const second = pageBookings(withNew, 2, decodeBookingCursor(first.nextCursor!));
  assert.deepEqual(second.items.map((r) => r.id), ['z']);
  assert.equal(second.nextCursor, null);
});

test('bookings: cursor round-trips and rejects junk', () => {
  const c = encodeBookingCursor(row('cls|1', '2026-11-01T08:00Z'));
  assert.deepEqual(decodeBookingCursor(c), { date: '2026-11-01T08:00:00.000Z', id: 'cls|1' });
  assert.equal(decodeBookingCursor('not-a-cursor'), null);
});

test('subscriptions: overlap and status from dates', () => {
  const nov = { start: Date.parse('2026-11-01T00:00Z'), end: Date.parse('2026-11-30T23:59Z') };
  const dec = { start: Date.parse('2026-12-01T00:00Z'), end: Date.parse('2026-12-31T23:59Z') };
  assert.equal(overlaps(nov, dec), false);
  assert.equal(overlaps(nov, { start: Date.parse('2026-11-20T00:00Z'), end: Date.parse('2026-12-10T00:00Z') }), true);
  const now = Date.parse('2026-11-08T10:00Z');
  assert.equal(statusForWindow(nov, now), 'ACTIVE');
  assert.equal(statusForWindow(dec, now), 'PENDING');
  assert.equal(statusForWindow({ start: Date.parse('2026-10-01T00:00Z'), end: Date.parse('2026-10-31T23:59Z') }, now), 'EXPIRED');
});

test('subscriptions: an item with no dates uses its calendar month (Israel time)', () => {
  const w = windowOf({ targetMonth: '2026-11' });
  assert.equal(new Date(w.start).toISOString(), '2026-10-31T21:00:00.000Z');
  assert.equal(new Date(w.end).toISOString(), '2026-11-30T20:59:59.999Z');
});

test('subscriptions: same plan by product id, else by name', () => {
  assert.equal(samePlan({ productId: 'p1', productName: 'A' }, { productId: 'p1', productName: 'B' }), true);
  assert.equal(samePlan({ productId: 'p1', productName: 'A' }, { productId: 'p2', productName: 'A' }), false);
  assert.equal(samePlan({ productName: ' Gold ' }, { productId: 'p9', productName: 'gold' }), true);
});

const sub = (membershipId: string, targetMonth: string, extra: Record<string, unknown> = {}) =>
  ({ PK: 'MEMBER#u', SK: `MEMBERSHIP#${targetMonth}#${membershipId}`, membershipId, targetMonth, status: 'ACTIVE', productId: 'p1', createdAt: `${targetMonth}-01T09:00:00Z`, ...extra } as unknown as MembershipItem);
const order = (orderId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ orderId, createdAt, status: 'completed', amount: 400, productId: 'p1', productName: 'Gold', productType: 'subscription', ...extra } as any);

test('payments: explicit link wins, others matched by month, one order per subscription', () => {
  const subs = [sub('s-oct', '2026-10'), sub('s-nov', '2026-11'), sub('s-nov-manual', '2026-11', { paymentOrderId: 'o-nov', isManuallyCreated: true })];
  const orders = [order('o-oct', '2026-10-01T08:00:00Z'), order('o-nov', '2026-11-01T08:00:00Z')];
  const links = resolvePaymentLinks(subs as any, orders);
  assert.deepEqual(links.get('s-nov-manual'), { orderId: 'o-nov', kind: 'linked' });
  assert.deepEqual(links.get('s-oct'), { orderId: 'o-oct', kind: 'matched' });
  assert.equal(links.get('s-nov'), undefined); // o-nov is taken by the explicit link
});

test('payments: a cancelled subscription frees its payment for a match', () => {
  const subs = [sub('s-bad', '2026-11', { status: 'CANCELLED', paymentOrderId: 'o-nov' }), sub('s-good', '2026-11')];
  const links = resolvePaymentLinks(subs as any, [order('o-nov', '2026-11-01T08:00:00Z')]);
  assert.deepEqual(links.get('s-good'), { orderId: 'o-nov', kind: 'matched' });
  assert.deepEqual(links.get('s-bad'), { orderId: 'o-nov', kind: 'linked' });
});

test('payments: different product or punch cards are never matched', () => {
  const subs = [sub('s1', '2026-11')];
  const orders = [order('o1', '2026-11-02T08:00:00Z', { productId: 'p2' }), order('o2', '2026-11-03T08:00:00Z', { productType: 'punch_card' })];
  assert.equal(resolvePaymentLinks(subs as any, orders).size, 0);
});
