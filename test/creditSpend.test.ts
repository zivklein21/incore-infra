// Run: npm test
// Credit spending order, lapsed-credit refusal and refunds — lib/creditSpend.ts
// (+ the admin balance edit rule in lib/walletCredit.ts). Pure functions only,
// no DynamoDB. Dates are mid-day UTC so the Israel-date conversion can't
// flip a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketExpiresOn, chooseCredit, refundBucket, spendFromBucketItem, UNTRACKED_BUCKET,
} from '../src/lib/creditSpend';
import { adjustCreditBuckets, creditExpiries, expiredBuckets } from '../src/lib/walletCredit';
import type { PunchCardItem, WalletItem } from '../src/lib/entities';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const wallet = (extraPunches: number, creditBuckets?: Record<string, number>): WalletItem =>
  ({ PK: 'MEMBER#u', SK: 'WALLET#PRIMARY', extraPunches, creditBuckets });
const card = (cardId: string, remainingPunches: number, expiry: string | null, createdAt?: string): PunchCardItem =>
  ({ PK: 'MEMBER#u', SK: `PUNCHCARD#${cardId}`, cardId, remainingPunches, expiryDate: expiry ? `${expiry}T21:59:59.000Z` : null, notes: '', source: 'admin_credit', ...(createdAt ? { createdAt } : {}) } as PunchCardItem);

test('bucket expiry: earned in M, valid through the last day of M+1', () => {
  assert.equal(bucketExpiresOn('2027-10'), '2027-11-30');
  assert.equal(bucketExpiresOn('2027-11'), '2027-12-31');
  assert.equal(bucketExpiresOn('2027-12'), '2028-01-31');
});

test('mixed batches (Nov 30 + Dec 31 + no date): soonest expiry first, no date last', () => {
  // Oct-earned → Nov 30, Nov-earned → Dec 31, 1 untracked (no expiry)
  let w = wallet(4, { '2027-10': 2, '2027-11': 1 });
  assert.deepEqual(chooseCredit(w, [], day('2027-11-10')), { consumedFrom: 'EXTRA_PUNCH', creditBucket: '2027-10' });
  w = wallet(2, { '2027-11': 1 });
  assert.deepEqual(chooseCredit(w, [], day('2027-11-10')), { consumedFrom: 'EXTRA_PUNCH', creditBucket: '2027-11' });
  w = wallet(1, {});
  assert.deepEqual(chooseCredit(w, [], day('2027-11-10')), { consumedFrom: 'EXTRA_PUNCH', creditBucket: UNTRACKED_BUCKET });
});

test('mixed wallet + punch cards: soonest expiry wins across both', () => {
  const w = wallet(2, { '2027-10': 2 }); // Nov 30
  const cards = [card('dec', 1, '2027-12-15'), card('nov15', 1, '2027-11-15'), card('forever', 1, null)];
  assert.deepEqual(chooseCredit(w, cards, day('2027-11-10')), { consumedFrom: 'ADMIN_CARD', adminCardId: 'nov15' });
  // without the Nov 15 card, the wallet's Nov 30 batch beats the Dec 15 card; no-expiry card last
  assert.deepEqual(chooseCredit(w, cards.filter((c) => c.cardId !== 'nov15'), day('2027-11-10')), { consumedFrom: 'EXTRA_PUNCH', creditBucket: '2027-10' });
  assert.deepEqual(chooseCredit(wallet(0), [card('forever', 1, null), card('dec', 1, '2027-12-15')], day('2027-11-10')), { consumedFrom: 'ADMIN_CARD', adminCardId: 'dec' });
});

test('several punch cards: soonest expiry first, tie → earned first', () => {
  const cards = [card('b', 1, '2027-12-31', '2027-10-05T00:00:00Z'), card('a', 1, '2027-12-31', '2027-09-01T00:00:00Z'), card('c', 1, '2028-01-31')];
  assert.deepEqual(chooseCredit(wallet(0), cards, day('2027-11-10')), { consumedFrom: 'ADMIN_CARD', adminCardId: 'a' });
});

test('expired + valid: lapsed batch is skipped', () => {
  const w = wallet(5, { '2027-09': 3, '2027-10': 2 }); // Sep-earned lapsed Oct 31
  assert.deepEqual(chooseCredit(w, [], day('2027-11-05')), { consumedFrom: 'EXTRA_PUNCH', creditBucket: '2027-10' });
  // an expired card is skipped too
  assert.deepEqual(chooseCredit(wallet(0), [card('old', 2, '2027-10-31'), card('ok', 1, '2027-12-31')], day('2027-11-05')), { consumedFrom: 'ADMIN_CARD', adminCardId: 'ok' });
});

test('validity is checked against the class date, not the booking date', () => {
  // Oct-earned credit (valid through Nov 30) can't pay for a Dec 2 class
  const w = wallet(3, { '2027-10': 2, '2027-11': 1 });
  assert.deepEqual(chooseCredit(w, [], day('2027-12-02')), { consumedFrom: 'EXTRA_PUNCH', creditBucket: '2027-11' });
});

test('only expired credit: refused with credits_expired (Hebrew message)', () => {
  assert.deepEqual(chooseCredit(wallet(3, { '2027-09': 3 }), [], day('2027-11-05')), { error: 'credits_expired' });
  assert.deepEqual(chooseCredit(wallet(0), [card('old', 2, '2027-10-31')], day('2027-11-05')), { error: 'credits_expired' });
  assert.deepEqual(chooseCredit(wallet(0), [], day('2027-11-05')), { error: 'no_credits' });
  assert.deepEqual(chooseCredit(wallet(0), [card('used', 0, '2027-12-31')], day('2027-11-05')), { error: 'no_credits' });
});

test("explicit picks: 'extra_punch' stays in the wallet, a card id must be valid", () => {
  const w = wallet(2, { '2027-10': 2 });
  const cards = [card('nov15', 1, '2027-11-15'), card('old', 1, '2027-10-01')];
  assert.deepEqual(chooseCredit(w, cards, day('2027-11-10'), { walletCardId: 'extra_punch' }), { consumedFrom: 'EXTRA_PUNCH', creditBucket: '2027-10' });
  assert.deepEqual(chooseCredit(w, cards, day('2027-11-10'), { walletCardId: 'nov15' }), { consumedFrom: 'ADMIN_CARD', adminCardId: 'nov15' });
  assert.deepEqual(chooseCredit(w, cards, day('2027-11-10'), { walletCardId: 'old' }), { error: 'credits_expired' });
  assert.deepEqual(chooseCredit(w, cards, day('2027-11-10'), { walletCardId: 'missing' }), { error: 'card_unavailable' });
  assert.deepEqual(chooseCredit(wallet(1, { '2027-09': 1 }), [], day('2027-11-10'), { walletCardId: 'extra_punch' }), { error: 'credits_expired' });
});

test('no membership: wallet credit not allowed, punch cards still are', () => {
  const w = wallet(2, { '2027-10': 2 });
  assert.deepEqual(chooseCredit(w, [], day('2027-11-10'), { allowWallet: false }), { error: 'no_credits' });
  assert.deepEqual(chooseCredit(w, [card('c', 1, '2027-12-31')], day('2027-11-10'), { allowWallet: false }), { consumedFrom: 'ADMIN_CARD', adminCardId: 'c' });
  assert.deepEqual(chooseCredit(w, [], day('2027-11-10'), { allowWallet: false, walletCardId: 'extra_punch' }), { error: 'card_unavailable' });
});

test('spend writes: from the chosen batch, untracked never dips into tracked credit', () => {
  const w = wallet(4, { '2027-10': 2, '2027-11': 1 });
  const fromBucket = spendFromBucketItem('u', w, '2027-10', 'now').Update!;
  assert.match(fromBucket.UpdateExpression!, /creditBuckets\.#m :negOne/);
  assert.equal(fromBucket.ExpressionAttributeNames!['#m'], '2027-10');
  assert.match(fromBucket.ConditionExpression!, /creditBuckets\.#m > :zero/);
  const untracked = spendFromBucketItem('u', w, UNTRACKED_BUCKET, 'now').Update!;
  assert.equal(untracked.ConditionExpression, 'extraPunches > :tracked');
  assert.equal(untracked.ExpressionAttributeValues![':tracked'], 3);
});

test('refund to the original batch while it is still valid', () => {
  assert.equal(refundBucket('2027-10', day('2027-11-10')), '2027-10'); // valid through Nov 30
  assert.equal(refundBucket('2027-10', day('2027-11-30')), '2027-10'); // last valid day
  assert.equal(refundBucket(UNTRACKED_BUCKET, day('2027-11-10')), UNTRACKED_BUCKET);
});

test('refund when the original batch has lapsed (or was never recorded): current month', () => {
  assert.equal(refundBucket('2027-09', day('2027-11-10')), '2027-11'); // lapsed Oct 31
  assert.equal(refundBucket(undefined, day('2027-11-10')), '2027-11'); // booking predates creditBucket
  assert.equal(refundBucket(null, day('2027-11-10')), '2027-11');
});

test('admin balance edit keeps each batch\'s expiry (adjustCreditBuckets)', () => {
  const b = { '2027-08': 3, '2027-09': 2, '2027-10': 5 };
  assert.deepEqual(adjustCreditBuckets(b, 10, 12, '2027-10'), { '2027-08': 3, '2027-09': 2, '2027-10': 7 });
  assert.deepEqual(adjustCreditBuckets(b, 10, 7, '2027-10'), { '2027-09': 2, '2027-10': 5 });
  assert.deepEqual(adjustCreditBuckets(b, 10, 0, '2027-10'), {});
  assert.deepEqual(adjustCreditBuckets({ '2027-09': 2, '2027-10': 2 }, 3, 3, '2027-10'), { '2027-09': 1, '2027-10': 2 });
});

// ── Launch grace period: earned up to Nov 2026 → valid until Dec 31, 2026 ──
test('grace: anything earned up to Nov 2026 expires Dec 31, 2026; Dec 2026 on is the normal rule', () => {
  assert.equal(bucketExpiresOn('2026-08'), '2026-12-31');
  assert.equal(bucketExpiresOn('2026-10'), '2026-12-31');
  assert.equal(bucketExpiresOn('2026-11'), '2026-12-31');
  assert.equal(bucketExpiresOn('2026-12'), '2027-01-31');
});

test('grace: expiry job removes nothing on Nov 1 or Dec 1, everything pre-Dec on Jan 1', () => {
  const w = wallet(9, { '2026-09': 2, '2026-10': 3, '2026-11': 1, '2026-12': 3 });
  assert.deepEqual(expiredBuckets(w, day('2026-11-01')), {});
  assert.deepEqual(expiredBuckets(w, day('2026-12-01')), {});
  assert.deepEqual(expiredBuckets(w, day('2026-12-31')), {});
  assert.deepEqual(expiredBuckets(w, day('2027-01-01')), { '2026-09': 2, '2026-10': 3, '2026-11': 1 });
  assert.deepEqual(expiredBuckets(w, day('2027-02-01')), { '2026-09': 2, '2026-10': 3, '2026-11': 1, '2026-12': 3 });
});

test('grace: batches sharing Dec 31 are shown as one card', () => {
  assert.deepEqual(creditExpiries(wallet(10, { '2026-09': 2, '2026-10': 3, '2026-12': 4 })), [
    { amount: 5, expiresOn: '2026-12-31' },
    { amount: 4, expiresOn: '2027-01-31' },
    { amount: 1, expiresOn: null },
  ]);
});

test('grace: Oct-earned credit can pay for a December class; refunds keep it until Dec 31', () => {
  const w = wallet(3, { '2026-10': 2, '2026-12': 1 });
  assert.deepEqual(chooseCredit(w, [], day('2026-12-20')), { consumedFrom: 'EXTRA_PUNCH', creditBucket: '2026-10' });
  assert.equal(refundBucket('2026-10', day('2026-12-15')), '2026-10');
  assert.equal(refundBucket('2026-10', day('2027-01-02')), '2027-01');
});
