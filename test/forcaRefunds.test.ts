// Run: npm test
// FORCA refunds (זיכוי חלקי): every credit is an immediate HYP refund against
// the trainee's most recent subscription charge, never more than is left on
// it; anything HYP can't do is recorded as "להחזיר ידנית ב-HYP" for Or to
// mark done. Plus the suggestion (sessions left this month × price).
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';
process.env.HYP_MASOF = 'masof';
process.env.HYP_KEY = 'key';
process.env.HYP_PASSP = 'passp';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const rules = require('../src/lib/forcaRefunds/rules');
const { issueForcaRefund } = require('../src/lib/forcaRefunds/store');
const { adminForcaRefund, adminForcaRefunds } = require('../src/lib/forcaRefunds/handlers');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; mock.timers.reset(); });

const setNow = (iso: string) => mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() });

// ── A small in-memory table ─────────────────────────────────────────────────

type Db = { items: Map<string, any>; hypCalls: URL[]; hypReply: string };
const keyOf = (table: string, k: any) => `${table}|${k.PK}|${k.SK}`;
const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const conditionFailed = () => { const e = new Error('condition'); (e as any).name = 'ConditionalCheckFailedException'; return e; };

function checkCondition(item: any, cond: string | undefined, values: any = {}): boolean {
  if (!cond) return true;
  switch (cond) {
    case 'attribute_not_exists(PK)': return !item;
    case 'attribute_not_exists(refundedTotal) OR refundedTotal = :from': return !!item && (item.refundedTotal === undefined || item.refundedTotal === values[':from']);
    case 'refundedTotal = :from': return !!item && item.refundedTotal === values[':from'];
    case '#status IN (:pending, :processing)': return !!item && [values[':pending'], values[':processing']].includes(item.status);
    default: throw new Error(`test db: unknown condition ${cond}`);
  }
}

function applySet(item: any, expr: string, names: any = {}, values: any = {}) {
  const body = expr.replace(/^SET\s+/, '');
  for (const clause of body.split(',').map((c) => c.trim())) {
    const [l, r] = clause.split('=').map((x) => x.trim());
    item[names[l] ?? l] = clone(values[r]);
  }
}

function makeDb(seed: Record<string, any>, hypReply = 'CCode=0&Id=R-777'): Db {
  const db: Db = { items: new Map(Object.entries(clone(seed))), hypCalls: [], hypReply };
  const all = (table: string) => [...db.items.entries()].filter(([k]) => k.startsWith(`${table}|`)).map(([, v]) => v);
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const name = cmd.constructor.name; const input = cmd.input;
    const v = input.ExpressionAttributeValues ?? {};
    if (name === 'GetCommand') return { Item: clone(db.items.get(keyOf(input.TableName, input.Key))) };
    if (name === 'PutCommand') {
      const k = keyOf(input.TableName, input.Item);
      if (!checkCondition(db.items.get(k), input.ConditionExpression, v)) throw conditionFailed();
      db.items.set(k, clone(input.Item)); return {};
    }
    if (name === 'UpdateCommand') {
      const k = keyOf(input.TableName, input.Key);
      const cur = db.items.get(k);
      if (!checkCondition(cur, input.ConditionExpression, v)) throw conditionFailed();
      const item = cur ?? { ...input.Key };
      applySet(item, input.UpdateExpression, input.ExpressionAttributeNames, v);
      db.items.set(k, item); return {};
    }
    if (name === 'QueryCommand') {
      let rows = all(input.TableName);
      if (input.IndexName === 'GSI1') {
        rows = rows.filter((r) => r.GSI1PK === v[':pk'] && String(r.GSI1SK).startsWith(v[':prefix']));
        rows.sort((a, b) => (input.ScanIndexForward === false ? b.GSI1SK.localeCompare(a.GSI1SK) : a.GSI1SK.localeCompare(b.GSI1SK)));
        if (input.Limit) rows = rows.slice(0, input.Limit);
      } else if (input.IndexName === 'GSI2') {
        rows = rows.filter((r) => r.GSI2PK === v[':pk'] && (v[':g'] === undefined || r.groupId === v[':g']));
        rows.sort((a, b) => b.GSI2SK.localeCompare(a.GSI2SK));
      } else rows = [];
      return { Items: clone(rows) };
    }
    throw new Error(`test db: unexpected ${name}`);
  }) as typeof ddb.send;
  globalThis.fetch = (async (url: string) => {
    db.hypCalls.push(new URL(String(url)));
    return { ok: true, status: 200, text: async () => db.hypReply, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return db;
}

const OR = { PK: 'MEMBER#or', SK: 'PROFILE', role: 'admin', identity: { role: 'admin', first_name: 'Or', last_name: 'Saraf' } };
const ev = (uid: string, body: unknown) => ({ body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { sub: uid } } } } }) as any;
const call = async (fn: any, uid: string, body: unknown) => { const r = await fn(ev(uid, body)); return { status: r.statusCode, body: JSON.parse(r.body) }; };

function order(id: string, at: string, amount: number, extra: Record<string, any> = {}) {
  return {
    [`forca|FORCASUBORDER#${id}|METADATA`]: {
      PK: `FORCASUBORDER#${id}`, SK: 'METADATA', GSI1PK: 'MEMBER#kid1', GSI1SK: `FORCASUBORDER#${at}#${id}`,
      GSI2PK: 'FORCASUBORDER', GSI2SK: `${at}#${id}`, orderId: id, userId: 'kid1', status: 'completed',
      subscriptionProductId: 'sp1', productName: 'חודשי', groupId: 'g1', groupName: 'בנות 10', amount,
      hypTransactionId: `T-${id}`, createdAt: at, updatedAt: at, ...extra,
    },
  };
}
function session(id: string, isoDate: string, groupId = 'g1') {
  const day = new Date(isoDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  return { [`forca|CLASS#${id}|METADATA`]: { PK: `CLASS#${id}`, SK: 'METADATA', GSI2PK: `CLASSDATE#${day}`, GSI2SK: `CLASS#${id}`, date: isoDate, groupId } };
}
const base = (extra: Record<string, any> = {}) => ({
  'incore|MEMBER#or|PROFILE': OR,
  'forca|MEMBER#kid1|PROFILE': { PK: 'MEMBER#kid1', SK: 'PROFILE', identity: { groupId: 'g1', firstName: 'נועה' } },
  'forca|GROUP#g1|METADATA': { PK: 'GROUP#g1', SK: 'METADATA', name: 'בנות 10' },
  ...extra,
});
const refundsIn = (db: Db) => [...db.items.values()].filter((i) => String(i.PK).startsWith('FORCAREFUND#'));

// ── Suggestion ──────────────────────────────────────────────────────────────

test('rules: days to month end, sessions left, suggested amount', () => {
  assert.deepEqual(rules.daysToMonthEnd('2026-11-28'), ['2026-11-28', '2026-11-29', '2026-11-30']);
  assert.equal(rules.daysToMonthEnd('2027-02-01').length, 28);
  const now = new Date('2026-11-16T15:00:00Z');
  const sessions = [
    { date: '2026-11-16T14:00:00Z', groupId: 'g1' }, // today, already started
    { date: '2026-11-16T16:00:00Z', groupId: 'g1' }, // today, later
    { date: '2026-11-18T16:00:00Z', groupId: 'g1' },
    { date: '2026-11-18T16:00:00Z', groupId: 'g2' }, // another group
  ];
  assert.equal(rules.countRemainingSessions(sessions, 'g1', now), 2);
  assert.deepEqual(rules.suggestRefund(3, 62.5), { sessions: 3, pricePerSession: 62.5, amount: 187.5 });
  assert.deepEqual(rules.suggestRefund(0, 62.5).amount, 0);
  assert.equal(rules.suggestRefund(3, 33.33).amount, 99.99);
});

test('suggestion: her group\'s sessions from now to the end of the month × ₪62.5 by default', async () => {
  setNow('2026-11-24T12:00:00Z'); // Tue 14:00 Israel
  makeDb(base({
    ...session('s0', '2026-11-24T10:00:00Z'), // this morning: done
    ...session('s1', '2026-11-24T15:00:00Z'),
    ...session('s2', '2026-11-26T15:00:00Z'),
    ...session('s3', '2026-11-30T15:00:00Z'),
    ...session('s4', '2026-12-01T15:00:00Z'), // next month
    ...session('x1', '2026-11-26T15:00:00Z', 'g2'),
  }));
  const r = await call(adminForcaRefunds, 'or', { traineeId: 'kid1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.suggestion.sessions, 3);
  assert.equal(r.body.suggestion.pricePerSession, 62.5);
  assert.equal(r.body.suggestion.amount, 187.5);
  assert.equal(r.body.suggestion.groupName, 'בנות 10');
});

test('suggestion: the price per session is a setting Or can change', async () => {
  setNow('2026-11-24T12:00:00Z');
  const db = makeDb(base({ ...session('s1', '2026-11-25T15:00:00Z'), ...session('s2', '2026-11-26T15:00:00Z') }));
  assert.equal((await call(adminForcaRefund, 'or', { action: 'setPrice', pricePerSession: 0 })).status, 400);
  assert.equal((await call(adminForcaRefund, 'or', { action: 'setPrice', pricePerSession: 70 })).status, 200);
  assert.equal(db.items.get('forca|APPCONFIG|FORCA_REFUND_SETTINGS').pricePerSession, 70);
  const r = await call(adminForcaRefunds, 'or', { traineeId: 'kid1' });
  assert.equal(r.body.suggestion.amount, 140);
});

// ── Refunds ─────────────────────────────────────────────────────────────────

test('refund: goes to HYP (zikoyAPI) against her most recent completed charge and is recorded', async () => {
  const db = makeDb(base({
    ...order('old', '2026-10-01T01:30:00Z', 250),
    ...order('new', '2026-11-01T01:30:00Z', 250),
    ...order('pend', '2026-11-10T01:30:00Z', 250, { status: 'pending' }),
  }));
  const r = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', agreementId: 'ag1', amount: 125, note: 'פציעה – הפסקה באמצע החודש' });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'refunded');
  assert.equal(db.hypCalls.length, 1);
  const q = db.hypCalls[0].searchParams;
  assert.equal(q.get('action'), 'zikoyAPI');
  assert.equal(q.get('TransId'), 'T-new');
  assert.equal(q.get('Amount'), '125');

  const [rec] = refundsIn(db);
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.refundTransactionId, 'R-777');
  assert.equal(rec.type, 'partial');
  assert.equal(rec.amount, 125);
  assert.equal(rec.note, 'פציעה – הפסקה באמצע החודש');
  assert.deepEqual(rec.createdBy, { uid: 'or', name: 'Or Saraf' });
  assert.equal(rec.orderId, 'new');
  assert.equal(rec.agreementId, 'ag1');
  assert.equal(db.items.get('forca|FORCASUBORDER#new|METADATA').refundedTotal, 125);
  assert.equal(db.items.get('forca|FORCASUBORDER#new|METADATA').status, 'completed'); // the charge itself is untouched
});

test('refund: never more than is left on the charge — the rest goes to manual, nothing sent', async () => {
  const db = makeDb(base(order('new', '2026-11-01T01:30:00Z', 250)));
  await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 200, note: 'ראשון' });
  const r = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 60, note: 'שני' });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'manual');
  assert.match(r.body.message, /להחזיר ידנית ב-HYP/);
  assert.equal(r.body.refund.manualReason, 'exceeds_refundable');
  assert.equal(r.body.refund.refundableAtRequest, 50);
  assert.equal(db.hypCalls.length, 1);
  assert.equal(db.items.get('forca|FORCASUBORDER#new|METADATA').refundedTotal, 200);

  // Exactly what's left is fine.
  const ok = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 50, note: 'שלישי' });
  assert.equal(ok.body.outcome, 'refunded');
  assert.equal(db.items.get('forca|FORCASUBORDER#new|METADATA').refundedTotal, 250);
});

test('refund: HYP refuses → error shown, recorded as manual, the charge total is put back', async () => {
  const db = makeDb(base(order('new', '2026-11-01T01:30:00Z', 250)), 'CCode=33');
  const r = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 100, note: 'החזר' });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, 'manual');
  assert.match(r.body.message, /HYP דחתה/);
  const [rec] = refundsIn(db);
  assert.equal(rec.status, 'manual_pending');
  assert.equal(rec.manualReason, 'hyp_declined');
  assert.equal(rec.hypCCode, 33);
  assert.equal(db.items.get('forca|FORCASUBORDER#new|METADATA').refundedTotal, 0);
});

test('refund: no charge to refund against → manual, nothing sent', async () => {
  const db = makeDb(base());
  const r = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 100, note: 'החזר' });
  assert.equal(r.body.outcome, 'manual');
  assert.equal(r.body.refund.manualReason, 'no_charge');
  assert.equal(db.hypCalls.length, 0);
});

test('refund: a manual one can be marked done once', async () => {
  const db = makeDb(base());
  const created = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 100, note: 'החזר' });
  const id = created.body.refund.refundId;
  const done = await call(adminForcaRefund, 'or', { action: 'markManualDone', refundId: id });
  assert.equal(done.status, 200);
  assert.equal(done.body.refund.status, 'manual_done');
  assert.deepEqual(done.body.refund.manualDoneBy, { uid: 'or', name: 'Or Saraf' });
  assert.equal((await call(adminForcaRefund, 'or', { action: 'markManualDone', refundId: id })).status, 409);
  assert.equal(db.hypCalls.length, 0);
});

test('refund: a refunded one can\'t be marked as a manual refund', async () => {
  makeDb(base(order('new', '2026-11-01T01:30:00Z', 250)));
  const created = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 100, note: 'החזר' });
  assert.equal((await call(adminForcaRefund, 'or', { action: 'markManualDone', refundId: created.body.refund.refundId })).status, 409);
});

test('refund: input checks and admin only', async () => {
  makeDb(base({ 'forca|MEMBER#coach|PROFILE': { PK: 'MEMBER#coach', SK: 'PROFILE', identity: { role: 'coach' } } }));
  const bad = async (body: any) => (await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', ...body })).body.error;
  assert.equal(await bad({ amount: 0, note: 'x x' }), 'invalid_amount');
  assert.equal(await bad({ amount: 10.555, note: 'x x' }), 'invalid_amount');
  assert.equal(await bad({ amount: 20000, note: 'x x' }), 'amount_too_large');
  assert.equal(await bad({ amount: 50, note: ' ' }), 'note_required');
  assert.equal((await call(adminForcaRefund, 'coach', { action: 'create', traineeId: 'kid1', amount: 50, note: 'xx' })).status, 403);
  assert.equal((await call(adminForcaRefunds, 'coach', {})).status, 403);
});

test('list: every refund for the screen, and one trainee\'s with her last charge', async () => {
  makeDb(base(order('new', '2026-11-01T01:30:00Z', 250)));
  await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 100, note: 'א' + 'ב' });
  const all = await call(adminForcaRefunds, 'or', {});
  assert.equal(all.body.refunds.length, 1);
  assert.equal(all.body.refunds[0].PK, undefined);
  const one = await call(adminForcaRefunds, 'or', { traineeId: 'kid1' });
  assert.deepEqual(
    { amount: one.body.lastCharge.amount, refundedTotal: one.body.lastCharge.refundedTotal, refundable: one.body.lastCharge.refundable },
    { amount: 250, refundedTotal: 100, refundable: 150 },
  );
});

test('reuse: the medical freeze issues its own amount with type medical_freeze', async () => {
  const db = makeDb(base(order('new', '2026-11-01T01:30:00Z', 250)));
  const rec = await issueForcaRefund({
    traineeId: 'kid1', amount: 93.75, note: 'הקפאה רפואית', type: 'medical_freeze',
    by: { uid: 'or', name: 'Or Saraf' }, details: { from: '2026-11-20', to: '2026-11-30' },
  });
  assert.equal(rec.status, 'refunded');
  assert.equal(rec.type, 'medical_freeze');
  assert.deepEqual(rec.details, { from: '2026-11-20', to: '2026-11-30' });
  assert.equal(db.hypCalls[0].searchParams.get('Amount'), '93.75');
});
