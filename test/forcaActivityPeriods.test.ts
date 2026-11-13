// Run: npm test
// FORCA activity periods: the charge job charges only on days inside a
// period (never July/August), a due subscription is charged once when the
// next period starts, period edits only move future charges (with a
// preview), and the end-of-period notice goes out once per parent.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';
process.env.HYP_MASOF = 'masof';
process.env.HYP_KEY = 'key';
process.env.HYP_PASSP = 'passp';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const rules = require('../src/lib/forcaPeriods/rules');
const { runForcaBillingCycle } = require('../src/lib/forcaBillingAgreements');
const { adminListForcaPeriods, adminSaveForcaPeriods, getForcaActivityStatus } = require('../src/lib/forcaPeriods/handlers');
const { runPeriodEndReminders } = require('../src/lib/forcaPeriods/reminders');
const { effectiveNextChargeDateOf, forcaSignupClosed } = require('../src/lib/forcaPeriods/store');
const { israelDateStrOf } = require('../src/lib/israelTime');
const { handler: createPaymentPage } = require('../src/functions/createForcaSubscriptionPaymentPage');
const { handler: createTokenPurchase } = require('../src/functions/createForcaSubscriptionTokenPurchase');
const { handler: productsForParent } = require('../src/functions/getForcaSubscriptionProductsForParent');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; });

// The seeded periods (decided 2026-11-13): no charges July 1 – Aug 31.
const SEED = [
  { id: 'p1', name: 'אוקטובר–דצמבר', start: '2026-10-01', end: '2026-12-31' },
  { id: 'p2', name: 'ינואר–מרץ', start: '2027-01-01', end: '2027-03-31' },
  { id: 'p3', name: 'אפריל–יוני', start: '2027-04-01', end: '2027-06-30' },
  { id: 'p4', name: 'ספטמבר / היכרות', start: '2027-09-01', end: '2027-09-30' },
];

/** 03:30 Israel time on `day` (winter UTC+2 / summer UTC+3 doesn't matter for the day). */
const at = (day: string) => new Date(`${day}T01:30:00Z`);

// ── Rules ───────────────────────────────────────────────────────────────────

test('charge days: inside a period only — July and August never', () => {
  assert.equal(rules.isChargeDay(SEED, '2026-12-01'), true);
  assert.equal(rules.isChargeDay(SEED, '2027-06-30'), true);
  assert.equal(rules.isChargeDay(SEED, '2027-07-01'), false);
  assert.equal(rules.isChargeDay(SEED, '2027-08-15'), false);
  assert.equal(rules.isChargeDay(SEED, '2027-09-01'), true);
  assert.equal(rules.isChargeDay(SEED, '2027-10-01'), false, 'nothing after the last period');
  assert.equal(rules.isChargeDay([], '2026-12-01'), false);
});

test('effective charge day: due in July → charged Sep 1, once', () => {
  assert.equal(rules.effectiveChargeDay(SEED, '2027-07-01', '2027-06-15'), '2027-09-01');
  assert.equal(rules.effectiveChargeDay(SEED, '2027-07-01', '2027-08-20'), '2027-09-01', 'still due, waiting');
  assert.equal(rules.effectiveChargeDay(SEED, '2026-12-01', '2026-11-13'), '2026-12-01');
  assert.equal(rules.effectiveChargeDay(SEED, '2027-10-01', '2027-09-02'), null, 'no period ahead');
  // Jun charge → Jul 1 due → Sep 1 → Oct 1 (no period) : one charge in the summer gap, never back charges.
  assert.deepEqual(rules.simulateChargeDays(SEED, '2027-06-01', '2027-05-20', '2027-12-31'), ['2027-06-01', '2027-09-01']);
});

test('mid-month period start: charged that day', () => {
  const periods = [{ id: 'x', name: 'x', start: '2027-10-15', end: '2027-12-31' }];
  assert.equal(rules.effectiveChargeDay(periods, '2027-10-01', '2027-09-30'), '2027-10-15');
});

test('status: "אין פעילות" with the next start between periods', () => {
  const summer = rules.activityStatus(SEED, '2027-07-10');
  assert.equal(summer.inPeriod, false);
  assert.equal(summer.nextPeriod.id, 'p4');
  assert.equal(summer.offLabel, 'אין פעילות – חוזרים ב-1/9');
  assert.equal(rules.activityStatus(SEED, '2027-10-10').offLabel, 'אין פעילות');
  assert.equal(rules.activityStatus(SEED, '2026-11-13').offLabel, null);
  assert.equal(rules.currentPeriodEnd(SEED, '2026-11-13'), '2026-12-31');
  assert.equal(rules.currentPeriodEnd(SEED, '2027-07-10'), null);
});

test('validation: names, real dates, start ≤ end, no overlaps; sorted', () => {
  const id = () => 'new';
  assert.equal(rules.validatePeriods([{ name: '', start: '2026-10-01', end: '2026-12-31' }], id).error, 'invalid_name');
  assert.equal(rules.validatePeriods([{ name: 'a', start: '2026-02-30', end: '2026-12-31' }], id).error, 'invalid_date');
  assert.equal(rules.validatePeriods([{ name: 'a', start: '2026-12-31', end: '2026-10-01' }], id).error, 'start_after_end');
  const overlap = rules.validatePeriods([
    { name: 'a', start: '2026-10-01', end: '2026-12-31' },
    { name: 'b', start: '2026-12-31', end: '2027-03-31' },
  ], id);
  assert.equal(overlap.error, 'periods_overlap');
  const ok = rules.validatePeriods([SEED[2], SEED[0], { name: ' new ', start: '2027-09-01', end: '2027-09-30' }], id);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.map((p: any) => p.id), ['p1', 'p3', 'new']);
  assert.equal(ok.value[2].name, 'new');
  assert.equal(rules.validateReminder({ reminderDaysBefore: 0 }, rules.DEFAULT_SETTINGS).error, 'invalid_reminder_days');
  assert.equal(rules.validateReminder({}, rules.DEFAULT_SETTINGS).value.reminderDaysBefore, 25);
});

test('preview: removing September moves its charge and drops it from the totals', () => {
  const agreements = [{ agreementId: 'a1', dueDay: '2027-07-01', amount: 300, childName: 'נועה', payerName: 'הורה', productName: 'חודשי' }];
  const without = SEED.filter((p) => p.id !== 'p4');
  const { changes, months } = rules.previewPeriodChange(SEED, without, agreements, '2027-06-15');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before, '2027-09-01');
  assert.equal(changes[0].after, null);
  const sep = months.find((m: any) => m.month === '2027-09');
  assert.deepEqual([sep.beforeCount, sep.beforeTotal, sep.afterCount, sep.afterTotal], [1, 300, 0, 0]);
  assert.equal(months.length, 12);
  assert.equal(rules.previewPeriodChange(SEED, SEED, agreements, '2027-06-15').changes.length, 0, 'no edit, no change');
});

test('effectiveNextChargeDate: from a stored ISO date', () => {
  assert.equal(effectiveNextChargeDateOf(SEED, '2027-06-30T21:00:00.000Z', at('2027-06-20')), '2027-09-01');
  assert.equal(effectiveNextChargeDateOf(null, '2027-06-30T21:00:00.000Z'), null, 'periods unreadable');
});

test('reminder window: 25 days before the end, only with a next period', () => {
  assert.equal(rules.periodsDueForReminder(SEED, '2026-12-05', 25).length, 0);
  const due = rules.periodsDueForReminder(SEED, '2026-12-06', 25);
  assert.deepEqual(due.map((d: any) => [d.period.id, d.next.id]), [['p1', 'p2']]);
  assert.equal(rules.periodsDueForReminder(SEED, '2027-06-05', 25)[0].next.id, 'p4', 'June → September');
  assert.equal(rules.periodsDueForReminder(SEED, '2027-09-20', 25).length, 0, 'no period after September');
  assert.deepEqual(rules.periodsWithoutNext(SEED, '2026-11-13').map((p: any) => p.id), ['p4']);
  const text = rules.renderTemplate(rules.DEFAULT_REMINDER_BODY, rules.reminderVars(SEED[0], SEED[1], ['נועה', 'מאיה']));
  assert.match(text, /31\/12\/2026/);
  assert.match(text, /נועה, מאיה/);
  assert.doesNotMatch(text, /\{\{/);
});

// ── Charge job ──────────────────────────────────────────────────────────────

const AGREEMENT = {
  PK: 'FORCAAGREEMENT#ag1', SK: 'METADATA', agreementId: 'ag1', userId: 'kid1', payerUid: 'parent1', payerName: 'הורה',
  status: 'active', subscriptionProductId: 'sp1', productName: 'חודשי', groupId: 'g1', groupName: 'קבוצה',
  token: 'tok', tokenExpiryMonth: 12, tokenExpiryYear: 2030, amountPerCharge: 300,
  nextChargeDate: '2026-11-30T22:00:00.000Z', consecutiveFailures: 0, sourceOrderId: 'o1', createdAt: '2026-10-01', updatedAt: '2026-10-01',
};
const PROFILES: Record<string, any> = {
  'forca|MEMBER#kid1|PROFILE': { PK: 'MEMBER#kid1', SK: 'PROFILE', identity: { first_name: 'נועה', last_name: 'כהן', role: 'member' } },
  'forca|MEMBER#parent1|PROFILE': { PK: 'MEMBER#parent1', SK: 'PROFILE', identity: { first_name: 'דנה', last_name: 'כהן', email: 'p@example.com', idNumber: '000000018' }, expoPushToken: 'ExponentPushToken[x]' },
  'incore|MEMBER#admin1|PROFILE': { role: 'admin' },
  'forca|MEMBER#parent1|FAMILY#kid1': { PK: 'MEMBER#parent1', SK: 'FAMILY#kid1', childUid: 'kid1' },
};

type Stub = { calls: { name: string; input: any }[]; hyp: number; push: number };

function stub(periods: any[] | 'none' | 'throw', opts: { version?: number; markerExists?: boolean } = {}): Stub {
  const s: Stub = { calls: [], hyp: 0, push: 0 };
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const name = cmd.constructor.name;
    s.calls.push({ name, input: cmd.input });
    const key = cmd.input.Key ? `${cmd.input.TableName}|${cmd.input.Key.PK}|${cmd.input.Key.SK}` : '';
    if (name === 'GetCommand' && key === 'forca|APPCONFIG|FORCA_ACTIVITY_PERIODS') {
      if (periods === 'throw') throw new Error('dynamo down');
      return periods === 'none' ? {} : { Item: { periods, reminderDaysBefore: 25, reminderTitle: 't {{periodName}}', reminderBody: 'b {{childNames}}', version: opts.version ?? 3 } };
    }
    if (name === 'GetCommand') return { Item: PROFILES[key] };
    if (name === 'BatchGetCommand') {
      const keys = cmd.input.RequestItems.forca.Keys;
      return { Responses: { forca: keys.map((k: any) => PROFILES[`forca|${k.PK}|${k.SK}`]).filter(Boolean) } };
    }
    if (name === 'QueryCommand' && cmd.input.IndexName === 'GSI3') return { Items: [AGREEMENT] };
    if (name === 'PutCommand' && opts.markerExists && String(cmd.input.Item.SK).startsWith('PERIODNOTICE#')) {
      const e = new Error('exists'); (e as any).name = 'ConditionalCheckFailedException'; throw e;
    }
    if (name === 'QueryCommand') return { Items: [] };
    return {};
  }) as typeof ddb.send;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('exp.host')) { s.push++; return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'r' }] }), text: async () => '' }; }
    s.hyp++;
    return { ok: true, status: 200, text: async () => 'CCode=0&Id=12345&ACode=0012345', json: async () => ({}) };
  }) as unknown as typeof fetch;
  return s;
}

const gsi3Queried = (s: Stub) => s.calls.some((c) => c.name === 'QueryCommand' && c.input.IndexName === 'GSI3');

test('charge job: July 1 — no charge at all, even with a card on file', async () => {
  const s = stub(SEED);
  const res = await runForcaBillingCycle(at('2027-07-01'));
  assert.deepEqual(res, { processed: 0, succeeded: 0, failed: 0, skipped: 'outside_period' });
  assert.equal(s.hyp, 0);
  assert.equal(gsi3Queried(s), false, 'due agreements are not even read');
  assert.equal(s.calls.filter((c) => c.name !== 'GetCommand').length, 0, 'nothing written');
});

test('charge job: August — no charge', async () => {
  const s = stub(SEED);
  const res = await runForcaBillingCycle(at('2027-08-01'));
  assert.equal(res.skipped, 'outside_period');
  assert.equal(s.hyp, 0);
});

test('charge job: Dec 1 (inside a period) charges the due subscription', async () => {
  const s = stub(SEED);
  const res = await runForcaBillingCycle(at('2026-12-01'));
  assert.equal(res.skipped, undefined);
  assert.equal(res.processed, 1);
  assert.equal(res.succeeded, 1);
  assert.equal(s.hyp, 1);
});

test('charge job: September 1 charges (September is a period)', async () => {
  const s = stub(SEED);
  const res = await runForcaBillingCycle(at('2027-09-01'));
  assert.equal(res.succeeded, 1);
  assert.equal(s.hyp, 1);
});

test('charge job: no periods set up → no charge, admins alerted', async () => {
  const s = stub('none');
  const res = await runForcaBillingCycle(at('2026-12-01'));
  assert.equal(res.skipped, 'no_periods');
  assert.equal(s.hyp, 0);
  assert.ok(s.calls.some((c) => c.name === 'PutCommand' && c.input.Item.type === 'forca_billing_skipped'));
});

test('charge job: periods unreadable → no charge that day', async () => {
  const s = stub('throw');
  const res = await runForcaBillingCycle(at('2026-12-01'));
  assert.equal(res.skipped, 'periods_unreadable');
  assert.equal(s.hyp, 0);
});

// ── Endpoints (editing periods) ─────────────────────────────────────────────

const ev = (uid: string, body?: unknown) => ({
  body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
});

test('list: admin only; returns periods, reminder settings and warnings', async () => {
  stub(SEED);
  assert.equal((await adminListForcaPeriods(ev('kid1'))).statusCode, 403);
  const res = await adminListForcaPeriods(ev('admin1'));
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.periods.length, 4);
  assert.equal(body.reminderDaysBefore, 25);
  assert.equal(body.version, 3);
  assert.deepEqual(body.noNextPeriod, ['p4']);
});

test('save: dryRun previews which upcoming charges move, writes nothing', async () => {
  const s = stub(SEED);
  // Dec 1 charge moves to Jan 1 if the first period ends Nov 30.
  const edited = [{ ...SEED[0], end: '2026-11-30' }, ...SEED.slice(1)];
  const res = await adminSaveForcaPeriods(ev('admin1', { periods: edited, version: 3, dryRun: true }));
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.dryRun, true);
  assert.equal(body.preview.changes.length, 1);
  assert.equal(body.preview.changes[0].childName, 'נועה כהן');
  assert.equal(body.preview.changes[0].after, '2027-01-01');
  assert.equal(s.calls.filter((c) => c.name === 'PutCommand').length, 0);
});

test('save: writes version+1 with a version condition', async () => {
  const s = stub(SEED);
  const res = await adminSaveForcaPeriods(ev('admin1', { periods: SEED, version: 3, reminderDaysBefore: 30 }));
  assert.equal(res.statusCode, 200);
  const put = s.calls.find((c) => c.name === 'PutCommand')!;
  assert.equal(put.input.Item.version, 4);
  assert.equal(put.input.Item.reminderDaysBefore, 30);
  assert.equal(put.input.ConditionExpression, 'version = :v');
  assert.equal(put.input.ExpressionAttributeValues[':v'], 3);
});

test('save: stale version → 409; overlap → 400; non-admin → 403', async () => {
  stub(SEED);
  assert.equal((await adminSaveForcaPeriods(ev('admin1', { periods: SEED, version: 2 }))).statusCode, 409);
  const overlap = [...SEED, { name: 'x', start: '2026-12-15', end: '2027-01-15' }];
  const bad = await adminSaveForcaPeriods(ev('admin1', { periods: overlap, version: 3 }));
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(bad.body).error, 'periods_overlap');
  assert.equal((await adminSaveForcaPeriods(ev('parent1', { periods: SEED, version: 3 }))).statusCode, 403);
});

test('first save: allowed from no record (version 0)', async () => {
  const s = stub('none');
  const res = await adminSaveForcaPeriods(ev('admin1', { periods: SEED, version: 0 }));
  assert.equal(res.statusCode, 200);
  const put = s.calls.find((c) => c.name === 'PutCommand')!;
  assert.equal(put.input.Item.version, 1);
  assert.match(put.input.ConditionExpression, /attribute_not_exists/);
});

test('activity status: any user', async () => {
  stub(SEED);
  const body = JSON.parse((await getForcaActivityStatus(ev('parent1'))).body);
  assert.equal(typeof body.inPeriod, 'boolean');
  assert.ok('currentPeriodEnd' in body && 'offLabel' in body);
});

// ── End-of-period notice ────────────────────────────────────────────────────

test('notice: sent to the paying parent in the window, inbox + push', async () => {
  const s = stub(SEED);
  const res = await runPeriodEndReminders(at('2026-12-06'));
  assert.deepEqual(res, { periods: 1, sent: 1, alreadySent: 0, failed: 0 });
  const puts = s.calls.filter((c) => c.name === 'PutCommand').map((c) => c.input.Item);
  assert.equal(puts[0].PK, 'MEMBER#parent1');
  assert.equal(puts[0].SK, 'PERIODNOTICE#p1');
  assert.equal(puts[1].title, 't אוקטובר–דצמבר');
  assert.equal(puts[1].body, 'b נועה כהן');
  assert.equal(s.push, 1);
});

test('notice: once per parent per period', async () => {
  const s = stub(SEED, { markerExists: true });
  const res = await runPeriodEndReminders(at('2026-12-10'));
  assert.deepEqual(res, { periods: 1, sent: 0, alreadySent: 1, failed: 0 });
  assert.equal(s.push, 0);
});

test('notice: nothing outside the window', async () => {
  const s = stub(SEED);
  const res = await runPeriodEndReminders(at('2026-11-13'));
  assert.equal(res.periods, 0);
  assert.equal(gsi3Queried(s), false);
});

// ── Sign-up closed between periods ──────────────────────────────────────────

test('sign-up gate: open inside a period, closed in July with the next start', async () => {
  stub(SEED);
  assert.equal(await forcaSignupClosed(at('2026-12-01')), null);
  assert.equal(await forcaSignupClosed(at('2027-09-15')), null, 'September is open');
  const july = await forcaSignupClosed(at('2027-07-10'));
  assert.deepEqual(july, { error: 'signup_closed', message: 'ההרשמה לעונה הבאה נפתחת ב-1/9', nextStart: '2027-09-01' });
  assert.equal((await forcaSignupClosed(at('2027-10-05'))).message, 'ההרשמה לעונה הבאה תיפתח בקרוב', 'no period ahead');
  stub('none');
  assert.ok(await forcaSignupClosed(at('2026-12-01')), 'no periods → closed');
  stub('throw');
  assert.equal((await forcaSignupClosed(at('2026-12-01'))).error, 'signup_closed', 'unreadable → closed');
});

// The purchase requests use the real clock, so "today" is placed inside or outside a period around it.
const todayIl = () => israelDateStrOf(new Date());
const around = (inside: boolean) => inside
  ? [{ id: 'now', name: 'עכשיו', start: rules.addDays(todayIl(), -10), end: rules.addDays(todayIl(), 10) }]
  : [{ id: 'later', name: 'אחר כך', start: rules.addDays(todayIl(), 30), end: rules.addDays(todayIl(), 60) }];

for (const [label, fn] of [['payment page', createPaymentPage], ['saved-card purchase', createTokenPurchase]] as const) {
  test(`${label}: between periods → 409 signup_closed, nothing written`, async () => {
    const s = stub(around(false));
    const res = await fn(ev('parent1', { subscriptionProductId: 'sp1', childUid: 'kid1' }));
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'signup_closed');
    assert.equal(body.nextStart, rules.addDays(todayIl(), 30));
    assert.equal(s.calls.filter((c) => c.name === 'PutCommand' || c.name === 'UpdateCommand').length, 0);
    assert.equal(s.hyp, 0);
  });

  test(`${label}: inside a period → passes the gate`, async () => {
    stub(around(true));
    const res = await fn(ev('parent1', { subscriptionProductId: 'missing', childUid: 'kid1' }));
    assert.notEqual(res.statusCode, 409);
    assert.equal(res.statusCode, 404, 'stops later, at the unknown product');
  });
}

test('products for parent: signupClosed only between periods; products unchanged', async () => {
  stub(around(false));
  const closed = JSON.parse((await productsForParent(ev('parent1'))).body);
  assert.equal(closed.signupClosed.nextStart, rules.addDays(todayIl(), 30));
  assert.ok(Array.isArray(closed.children));
  stub(around(true));
  const open = JSON.parse((await productsForParent(ev('parent1'))).body);
  assert.equal(open.signupClosed, null);
});
