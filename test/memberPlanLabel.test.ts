// Run: npm test
// Member list row labels (lib/memberPlanLabel.ts): the INCORE plan name in
// place of "No active plan", and FORCA's group label. Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentPlan, forcaRowLabel, isCurrentPlan, legacyPlanLabel, planLabel, planNameOf, punchCardLabel, type PlanMembership,
} from '../src/lib/memberPlanLabel';

const now = new Date('2026-11-11T10:00:00.000Z');
const ms = (o: Partial<PlanMembership>): PlanMembership => ({
  PK: 'MEMBER#m1', SK: 'MEMBERSHIP#2026-11#a', membershipId: 'a', status: 'ACTIVE', targetMonth: '2026-11',
  isAutoRenew: true, monthlyLimit: 8, weeklyLimit: 2, allowedLegalCancellationsPerMonth: 2,
  usage: { totalMonthlyUsed: 0, legalCancellationsUsed: 0, lateCancellationsUsed: 0 }, weeklyUsage: {},
  startDate: '2026-10-31T22:00:00.000Z', endDate: '2026-11-30T21:59:59.999Z', productId: 'p8', ...o,
});
const products = new Map([['p8', 'מנוי חודשי 8 כניסות'], ['p12', 'מנוי חודשי 12 כניסות']]);

test('an ACTIVE membership covering today gives its product name', () => {
  assert.equal(planLabel([ms({})], [], products, now), 'מנוי חודשי 8 כניסות');
});

test('EXPIRED, CANCELLED and an unswept ACTIVE past its end are not a plan', () => {
  assert.equal(isCurrentPlan(ms({ status: 'EXPIRED' }), now), false);
  assert.equal(isCurrentPlan(ms({ status: 'CANCELLED' }), now), false);
  const october = ms({ targetMonth: '2026-10', startDate: '2026-09-30T21:00:00.000Z', endDate: '2026-10-31T21:59:59.999Z' });
  assert.equal(isCurrentPlan(october, now), false);
  assert.equal(planLabel([october], [], products, now), '');
});

test('PENDING (new member) and PAST_DUE (retrying) still count', () => {
  assert.equal(isCurrentPlan(ms({ status: 'PENDING' }), now), true);
  assert.equal(isCurrentPlan(ms({ status: 'PAST_DUE' }), now), true);
});

test("today's membership wins over next month's bought early, and over an expired one", () => {
  const dec = ms({ membershipId: 'b', productId: 'p12', targetMonth: '2026-12', startDate: '2026-11-30T22:00:00.000Z', endDate: '2026-12-31T21:59:59.999Z' });
  const old = ms({ membershipId: 'c', status: 'EXPIRED', productId: 'p12', createdAt: '2026-11-10T00:00:00.000Z' });
  assert.equal(currentPlan([dec, old, ms({})], now)?.membershipId, 'a');
  // Only next month's: still a plan (bought, starts on the 1st).
  assert.equal(planLabel([dec], [], products, now), 'מנוי חודשי 12 כניסות');
});

test('plan name: migration bridge, admin repair, product fallback', () => {
  assert.equal(planNameOf(ms({ type: 'CUSTOM_MIGRATION', productName: '' }), undefined), 'מנוי מעבר');
  assert.equal(planNameOf(ms({ type: 'CUSTOM_MIGRATION', title: 'גשר' }), undefined), 'גשר');
  assert.equal(planNameOf(ms({ isManuallyCreated: true, productName: 'תיקון' }), 'מוצר'), 'תיקון');
  assert.equal(planNameOf(ms({ productName: 'שמור' }), undefined), 'שמור');
  assert.equal(planNameOf(ms({ productName: 'שמור' }), 'מוצר'), 'מוצר');
});

test('punch card: only usable cards, summed; used when there is no membership', () => {
  const cards = [
    { remainingPunches: 3, expiryDate: null },
    { remainingPunches: 2, expiryDate: '2026-12-01T00:00:00.000Z' },
    { remainingPunches: 5, expiryDate: '2026-11-01T00:00:00.000Z' }, // expired
    { remainingPunches: 0 },
  ];
  assert.equal(punchCardLabel(cards, now), 'כרטיסייה · 5 כניסות');
  assert.equal(planLabel([], cards, products, now), 'כרטיסייה · 5 כניסות');
  assert.equal(planLabel([ms({})], cards, products, now), 'מנוי חודשי 8 כניסות');
  assert.equal(planLabel([], [], products, now), '');
});

test('legacy badge: only while not expired', () => {
  assert.equal(legacyPlanLabel({ plan: 'VIP', end: '2026-12-01' }, now), 'VIP');
  assert.equal(legacyPlanLabel({ plan: 'VIP', end: '2026-10-01' }, now), '');
  assert.equal(legacyPlanLabel({ plan: 'VIP', status: 'expired' }, now), '');
  assert.equal(legacyPlanLabel(undefined, now), '');
});

test('FORCA row label: group, no group, coach, parent', () => {
  const groups = new Map([['g1', 'נבחרת'], ['g2', 'מתחילות']]);
  assert.equal(forcaRowLabel({ role: 'member', accountType: 'member', groupId: 'g1' }, groups), 'קבוצה: נבחרת');
  assert.equal(forcaRowLabel({ role: 'member', accountType: 'member', groupId: null }, groups), 'ללא קבוצה');
  assert.equal(forcaRowLabel({ role: 'member', accountType: 'member', groupId: 'deleted' }, groups), 'ללא קבוצה');
  assert.equal(forcaRowLabel({ role: 'coach', accountType: 'member', groupIds: ['g1', 'g2'] }, groups), 'מאמן/ת · נבחרת, מתחילות');
  assert.equal(forcaRowLabel({ role: 'coach', accountType: 'member' }, groups), 'מאמן/ת');
  assert.equal(forcaRowLabel({ role: 'member', accountType: 'parent_only' }, groups), 'הורה');
});
