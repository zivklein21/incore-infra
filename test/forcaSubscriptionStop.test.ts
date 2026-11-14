// Run: npm test
// FORCA admin cancel: the three ways Or ends a subscription (now / end of the
// current period / a picked date), the summary before confirming, a
// scheduled stop that runs, editing and removing one, the audit trail, and
// above all: nothing is charged on or after the stop day, on any path.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';
process.env.HYP_MASOF = 'masof';
process.env.HYP_KEY = 'key';
process.env.HYP_PASSP = 'passp';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const rules = require('../src/lib/forcaSubscriptionStop/rules');
const { runForcaBillingCycle, chargeOneForcaAgreement } = require('../src/lib/forcaBillingAgreements');
const { runPeriodEndReminders } = require('../src/lib/forcaPeriods/reminders');
const { adminForcaSubscriptionStop, adminForcaSubscriptionStopPreview } = require('../src/lib/forcaSubscriptionStop/handlers');
const { handler: listAgreements } = require('../src/functions/adminListForcaBillingAgreements');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; mock.timers.reset(); });

// The seeded periods (2026-11-13): no charges July 1 – Aug 31.
const SEED = [
  { id: 'p1', name: 'אוקטובר–דצמבר', start: '2026-10-01', end: '2026-12-31' },
  { id: 'p2', name: 'ינואר–מרץ', start: '2027-01-01', end: '2027-03-31' },
  { id: 'p3', name: 'אפריל–יוני', start: '2027-04-01', end: '2027-06-30' },
  { id: 'p4', name: 'ספטמבר / היכרות', start: '2027-09-01', end: '2027-09-30' },
];

/** 03:30 Israel time on `day`. */
const at = (day: string) => new Date(`${day}T01:30:00Z`);
/** Midday Israel time on `day` (Or using the Backoffice). */
const noon = (day: string) => new Date(`${day}T10:00:00Z`);
const setNow = (d: Date) => mock.timers.enable({ apis: ['Date'], now: d.getTime() });

// ── A small in-memory table ─────────────────────────────────────────────────

type Db = { items: Map<string, any>; hyp: number; push: number; log: { name: string; input: any }[] };
const keyOf = (table: string, k: any) => `${table}|${k.PK}|${k.SK}`;
const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function getPath(obj: any, path: string[]) { return path.reduce((o, p) => (o == null ? undefined : o[p]), obj); }
function setPath(obj: any, path: string[], v: any) {
  let o = obj; for (const p of path.slice(0, -1)) { if (o[p] == null || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
  o[path[path.length - 1]] = v;
}
function removePath(obj: any, path: string[]) { const parent = getPath(obj, path.slice(0, -1)); if (parent) delete parent[path[path.length - 1]]; }
const resolvePath = (raw: string, names: any = {}) => raw.trim().split('.').map((p) => names[p] ?? p);

function applyUpdate(item: any, expr: string, names: any = {}, values: any = {}) {
  const re = /\b(SET|REMOVE)\b/g;
  const parts: { kw: string; body: string }[] = [];
  let m: RegExpExecArray | null; let last: { kw: string; start: number } | null = null;
  while ((m = re.exec(expr))) { if (last) parts.push({ kw: last.kw, body: expr.slice(last.start, m.index) }); last = { kw: m[1], start: m.index + m[0].length }; }
  if (last) parts.push({ kw: last.kw, body: expr.slice(last.start) });
  for (const { kw, body } of parts) {
    for (const clause of body.split(',').map((c) => c.trim()).filter(Boolean)) {
      if (kw === 'SET') { const [l, r] = clause.split('='); setPath(item, resolvePath(l, names), clone(values[r.trim()])); } else removePath(item, resolvePath(clause, names));
    }
  }
}

function checkCondition(item: any, cond: string | undefined, names: any = {}, values: any = {}): boolean {
  if (!cond) return true;
  const st = item ? item[names['#status'] ?? 'status'] : undefined;
  switch (cond) {
    case 'attribute_not_exists(PK)': return !item;
    case 'attribute_exists(PK) AND #status <> :cancelled': return !!item && st !== values[':cancelled'];
    case '#status IN (:active, :frozen) AND scheduledStop.stopDay = :prev': return !!item && [values[':active'], values[':frozen']].includes(st) && item.scheduledStop?.stopDay === values[':prev'];
    case '#status IN (:active, :frozen) AND attribute_not_exists(scheduledStop)': return !!item && [values[':active'], values[':frozen']].includes(st) && !item.scheduledStop;
    case 'scheduledStop.stopDay = :prev': return item?.scheduledStop?.stopDay === values[':prev'];
    case 'scheduledStop.stopDay = :d': return item?.scheduledStop?.stopDay === values[':d'];
    case 'payment.hypToken = :card': return item?.payment?.hypToken === values[':card'];
    default: throw new Error(`test db: unknown condition ${cond}`);
  }
}
const conditionFailed = () => { const e = new Error('condition'); (e as any).name = 'ConditionalCheckFailedException'; return e; };

function makeDb(seed: Record<string, any>): Db {
  const db: Db = { items: new Map(Object.entries(clone(seed))), hyp: 0, push: 0, log: [] };
  const all = (table: string) => [...db.items.entries()].filter(([k]) => k.startsWith(`${table}|`)).map(([, v]) => v);

  const exec = (name: string, input: any): any => {
    if (name === 'GetCommand') return { Item: clone(db.items.get(keyOf(input.TableName, input.Key))) };
    if (name === 'PutCommand') {
      const k = keyOf(input.TableName, input.Item);
      if (!checkCondition(db.items.get(k), input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw conditionFailed();
      db.items.set(k, clone(input.Item)); return {};
    }
    if (name === 'DeleteCommand') { db.items.delete(keyOf(input.TableName, input.Key)); return {}; }
    if (name === 'UpdateCommand') {
      const k = keyOf(input.TableName, input.Key);
      const cur = db.items.get(k);
      if (!checkCondition(cur, input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw conditionFailed();
      const item = cur ?? { ...input.Key };
      applyUpdate(item, input.UpdateExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues);
      db.items.set(k, item); return {};
    }
    if (name === 'BatchGetCommand') {
      const [table, req] = Object.entries(input.RequestItems)[0] as [string, any];
      return { Responses: { [table]: req.Keys.map((kk: any) => clone(db.items.get(keyOf(table, kk)))).filter(Boolean) } };
    }
    if (name === 'QueryCommand') {
      const v = input.ExpressionAttributeValues ?? {};
      let rows = all(input.TableName);
      if (input.IndexName === 'GSI3') {
        rows = rows.filter((r) => r.GSI3PK === v[':pk'] && (v[':now'] === undefined || r.GSI3SK <= v[':now']));
      } else if (input.IndexName === 'GSI2') {
        rows = rows.filter((r) => r.GSI2PK === v[':pk']);
        if (input.FilterExpression) {
          rows = rows.filter((r) => r.payerUid === v[':payer'] && r.agreementId !== v[':id'] && [v[':active'], v[':frozen']].includes(r.status) && r.token === v[':card']);
        }
      } else if (input.IndexName) {
        rows = [];
      } else if (/SK <= :upTo/.test(input.KeyConditionExpression)) {
        rows = rows.filter((r) => r.PK === v[':pk'] && r.SK <= v[':upTo']).sort((a, b) => a.SK.localeCompare(b.SK));
      } else if (/begins_with\(SK, :prefix\)/.test(input.KeyConditionExpression)) {
        rows = rows.filter((r) => r.PK === v[':pk'] && String(r.SK).startsWith(v[':prefix'])).sort((a, b) => b.SK.localeCompare(a.SK));
      } else {
        rows = [];
      }
      return { Items: clone(rows) };
    }
    if (name === 'TransactWriteCommand') {
      for (const t of input.TransactItems) {
        const [op, body] = Object.entries(t)[0] as [string, any];
        const k = keyOf(body.TableName, body.Key ?? body.Item);
        if (body.ConditionExpression && !checkCondition(db.items.get(k), body.ConditionExpression, body.ExpressionAttributeNames, body.ExpressionAttributeValues)) {
          const e = new Error('cancelled'); (e as any).name = 'TransactionCanceledException'; throw e;
        }
        void op;
      }
      for (const t of input.TransactItems) {
        const [op, body] = Object.entries(t)[0] as [string, any];
        exec(`${op}Command`, { ...body, ConditionExpression: undefined });
      }
      return {};
    }
    return {};
  };

  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    db.log.push({ name: cmd.constructor.name, input: cmd.input });
    return exec(cmd.constructor.name, cmd.input);
  }) as typeof ddb.send;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('exp.host')) { db.push++; return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'r' }] }), text: async () => '' }; }
    db.hyp++;
    return { ok: true, status: 200, text: async () => 'CCode=0&Id=12345&ACode=0012345', json: async () => ({}) };
  }) as unknown as typeof fetch;
  return db;
}

// Due Dec 1 2026 (Israel midnight), ₪300, card "tok".
const AGREEMENT = {
  PK: 'FORCAAGREEMENT#ag1', SK: 'METADATA', agreementId: 'ag1', userId: 'kid1', payerUid: 'parent1', payerName: 'דנה כהן',
  GSI1PK: 'MEMBER#kid1', GSI1SK: 'AGREEMENT#ag1', GSI2PK: 'FORCAAGREEMENT', GSI2SK: '2026-10-01T00:00:00.000Z#ag1',
  GSI3PK: 'FORCA_AGREEMENT_STATUS#active', GSI3SK: '2026-11-30T22:00:00.000Z',
  status: 'active', subscriptionProductId: 'sp1', productName: 'חודשי', groupId: 'g1', groupName: 'קבוצה',
  token: 'tok', tokenExpiryMonth: 12, tokenExpiryYear: 2030, amountPerCharge: 300,
  nextChargeDate: '2026-11-30T22:00:00.000Z', consecutiveFailures: 0, sourceOrderId: 'o1', createdAt: '2026-10-01', updatedAt: '2026-10-01',
};
const SIBLING = {
  ...AGREEMENT, PK: 'FORCAAGREEMENT#ag2', agreementId: 'ag2', userId: 'kid2', GSI1PK: 'MEMBER#kid2', GSI1SK: 'AGREEMENT#ag2',
  GSI2SK: '2026-10-02T00:00:00.000Z#ag2',
};

function seed(extra: Record<string, any> = {}): Record<string, any> {
  return {
    'forca|APPCONFIG|FORCA_ACTIVITY_PERIODS': { PK: 'APPCONFIG', SK: 'FORCA_ACTIVITY_PERIODS', periods: SEED, reminderDaysBefore: 25, reminderTitle: 't', reminderBody: 'b {{childNames}}', version: 1 },
    'forca|FORCAAGREEMENT#ag1|METADATA': AGREEMENT,
    'forca|MEMBER#kid1|PROFILE': { PK: 'MEMBER#kid1', SK: 'PROFILE', identity: { first_name: 'נועה', last_name: 'כהן', role: 'member' }, membership: { end: '2026-11-30T21:59:59.999Z' } },
    'forca|MEMBER#kid2|PROFILE': { PK: 'MEMBER#kid2', SK: 'PROFILE', identity: { first_name: 'מאיה', last_name: 'כהן', role: 'member' } },
    'forca|MEMBER#parent1|PROFILE': {
      PK: 'MEMBER#parent1', SK: 'PROFILE', identity: { first_name: 'דנה', last_name: 'כהן', email: 'p@example.com', idNumber: '000000018' },
      expoPushToken: 'ExponentPushToken[x]', payment: { hypToken: 'tok', hypTokenExpiryMonth: 12, hypTokenExpiryYear: 2030, hasSavedCard: true },
    },
    'incore|MEMBER#admin1|PROFILE': { PK: 'MEMBER#admin1', SK: 'PROFILE', role: 'admin', identity: { first_name: 'Or', last_name: 'Saraf', role: 'admin' } },
    ...extra,
  };
}

const ev = (uid: string, body: unknown) => ({ body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { sub: uid } } } } });
const agreementOf = (db: Db, id = 'ag1') => db.items.get(`forca|FORCAAGREEMENT#${id}|METADATA`);
const parentOf = (db: Db) => db.items.get('forca|MEMBER#parent1|PROFILE');
const stopIndex = (db: Db) => [...db.items.keys()].filter((k) => k.startsWith('forca|FORCA_SCHEDULED_STOP|'));
const stopLog = (db: Db, id = 'ag1') => [...db.items.entries()].filter(([k]) => k.startsWith(`forca|FORCAAGREEMENT#${id}|STOPLOG#`)).map(([, v]) => v);
const body = (res: any) => JSON.parse(res.body);

/** Runs the daily job for every day from `from` to `to` (inclusive) and returns the days charged. */
async function runDays(db: Db, from: string, to: string): Promise<string[]> {
  const charged: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) {
    const before = db.hyp;
    // The charge code sets the next due date from the clock, so the clock moves with the days.
    mock.timers.reset();
    setNow(at(d));
    await runForcaBillingCycle(at(d));
    if (db.hyp > before) charged.push(d);
  }
  mock.timers.reset();
  return charged;
}
function nextDay(d: string) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

// ── Rules ───────────────────────────────────────────────────────────────────

const base = { today: '2026-11-14', periods: SEED, status: 'active', dueDay: '2026-12-01', amount: 300, membershipEnd: '2026-11-30' };

test('rules — now: stop today, no charges left, active to the end of this month', () => {
  const r = rules.previewStop({ ...base, mode: 'now' });
  assert.equal(r.ok, true);
  assert.equal(r.value.stopDay, '2026-11-14');
  assert.deepEqual(r.value.remainingCharges, []);
  assert.equal(r.value.lastActiveDay, '2026-11-30');
  assert.equal(r.value.cardDeletedOn, '2026-11-14');
  assert.deepEqual(r.value.warnings, []);
  assert.match(r.value.refundNote, /אין החזר אוטומטי/);
});

test('rules — end of period: the day after the period, December charged, active to Dec 31', () => {
  const r = rules.previewStop({ ...base, mode: 'period_end' });
  assert.equal(r.value.stopDay, '2027-01-01');
  assert.deepEqual(r.value.remainingCharges, [{ day: '2026-12-01', amount: 300 }]);
  assert.equal(r.value.remainingTotal, 300);
  assert.equal(r.value.lastActiveDay, '2026-12-31');
  assert.equal(r.value.cardDeletedOn, '2027-01-01');
  // The stop day (Jan 1) is in a month that isn't charged: that's said plainly.
  assert.ok(r.value.warnings.some((w: any) => w.code === 'stop_month_not_charged'));
  assert.equal(rules.previewStop({ ...base, today: '2027-07-10', mode: 'period_end' }).error, 'no_current_period');
});

test('rules — picked date (January → March 20): Feb 1 and Mar 1 charged, active to Mar 31', () => {
  const r = rules.previewStop({ ...base, today: '2027-01-10', dueDay: '2027-02-01', membershipEnd: '2027-01-31', mode: 'date', stopDay: '2027-03-20' });
  assert.deepEqual(r.value.remainingCharges.map((c: any) => c.day), ['2027-02-01', '2027-03-01']);
  assert.equal(r.value.remainingTotal, 600);
  assert.equal(r.value.lastActiveDay, '2027-03-31');
  assert.equal(r.value.cardDeletedOn, '2027-03-20');
  assert.deepEqual(r.value.warnings, []);
});

test('rules — picked date on the 1st: that month is not charged, and it says so', () => {
  const r = rules.previewStop({ ...base, today: '2027-01-10', dueDay: '2027-02-01', membershipEnd: '2027-01-31', mode: 'date', stopDay: '2027-04-01' });
  assert.deepEqual(r.value.remainingCharges.map((c: any) => c.day), ['2027-02-01', '2027-03-01']);
  assert.equal(r.value.lastActiveDay, '2027-03-31');
  assert.ok(r.value.warnings.some((w: any) => w.code === 'stop_month_not_charged' && /31\/3\/2027/.test(w.message)));
});

test('rules — picked date in July: month outside a period, active only to June 30', () => {
  const r = rules.previewStop({ ...base, today: '2027-05-10', dueDay: '2027-06-01', membershipEnd: '2027-05-31', mode: 'date', stopDay: '2027-07-15' });
  assert.deepEqual(r.value.remainingCharges.map((c: any) => c.day), ['2027-06-01']);
  assert.equal(r.value.lastActiveDay, '2027-06-30');
  const codes = r.value.warnings.map((w: any) => w.code);
  assert.ok(codes.includes('month_outside_period'));
  assert.ok(codes.includes('stop_month_not_charged'));
});

test('rules — now, before this month was charged: says the trainee is not active this month', () => {
  const r = rules.previewStop({ ...base, today: '2026-12-01', membershipEnd: '2026-11-30', mode: 'now' });
  assert.equal(r.value.lastActiveDay, null);
  assert.ok(r.value.warnings.some((w: any) => w.code === 'this_month_not_charged'));
});

test('rules — validation: date in the future, not too far; paused / failed / cancelled', () => {
  assert.equal(rules.previewStop({ ...base, mode: 'date', stopDay: '2026-11-14' }).error, 'stop_day_not_in_future');
  assert.equal(rules.previewStop({ ...base, mode: 'date', stopDay: '2026-02-30' }).error, 'invalid_stop_day');
  assert.equal(rules.previewStop({ ...base, mode: 'date', stopDay: '2029-01-01' }).error, 'stop_day_too_far');
  assert.equal(rules.previewStop({ ...base, mode: 'later' }).error, 'invalid_mode');
  assert.equal(rules.previewStop({ ...base, status: 'cancelled', mode: 'now' }).error, 'already_cancelled');
  assert.equal(rules.previewStop({ ...base, status: 'failed', mode: 'date', stopDay: '2027-01-05' }).error, 'only_now_when_failed');
  assert.equal(rules.previewStop({ ...base, status: 'failed', mode: 'now' }).ok, true);
  const frozen = rules.previewStop({ ...base, status: 'frozen', mode: 'date', stopDay: '2027-03-20' });
  assert.deepEqual(frozen.value.remainingCharges, [], 'paused: nothing charged');
  assert.ok(frozen.value.warnings.some((w: any) => w.code === 'frozen'));
  assert.equal(rules.validateStopDetails({ reason: ' ' }).error, 'reason_required');
  assert.deepEqual(rules.validateStopDetails({ reason: ' מעבר דירה ', parentRequestId: 'inq-1' }), { ok: true, reason: 'מעבר דירה', parentRequestId: 'inq-1' });
});

// ── Endpoints ───────────────────────────────────────────────────────────────

test('admin only: a parent or coach can neither preview nor stop', async () => {
  const db = makeDb(seed());
  setNow(noon('2026-11-14'));
  assert.equal((await adminForcaSubscriptionStopPreview(ev('parent1', { agreementId: 'ag1', mode: 'now' }))).statusCode, 403);
  assert.equal((await adminForcaSubscriptionStop(ev('parent1', { agreementId: 'ag1', action: 'apply', mode: 'now', reason: 'x y' }))).statusCode, 403);
  assert.equal(agreementOf(db).status, 'active');
});

test('preview saves nothing and shows the exit point', async () => {
  const db = makeDb(seed());
  setNow(noon('2026-11-14'));
  const res = await adminForcaSubscriptionStopPreview(ev('admin1', { agreementId: 'ag1', mode: 'period_end' }));
  assert.equal(res.statusCode, 200);
  const b = body(res);
  assert.equal(b.periodEndStopDay, '2027-01-01');
  assert.equal(b.preview.stopDay, '2027-01-01');
  assert.equal(b.savedCard.willDelete, true);
  assert.equal(db.log.filter((c) => ['PutCommand', 'UpdateCommand', 'DeleteCommand', 'TransactWriteCommand'].includes(c.name)).length, 0);
});

test('option 1 (now): cancelled, token deleted from the subscription and the saved card, recorded; never charged', async () => {
  const db = makeDb(seed());
  setNow(noon('2026-11-14'));
  const res = await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'now', reason: 'ההורה ביקשה', parentRequestId: 'inq-7' }));
  assert.equal(res.statusCode, 200);
  const a = agreementOf(db);
  assert.equal(a.status, 'cancelled');
  assert.equal(a.token, '');
  assert.equal(a.GSI3PK, undefined);
  assert.equal(a.nextChargeDate, undefined);
  assert.equal(a.cancellation.mode, 'now');
  assert.equal(a.cancellation.reason, 'ההורה ביקשה');
  assert.equal(a.cancellation.parentRequestId, 'inq-7');
  assert.equal(a.cancellation.requestedBy, 'admin1');
  assert.equal(a.cancellation.requestedByName, 'Or Saraf');
  assert.equal(a.cancellation.savedCardDeleted, true);
  assert.equal(parentOf(db).payment.hypToken, undefined);
  assert.equal(parentOf(db).payment.hasSavedCard, false);
  // Membership untouched: active until the end of November.
  assert.equal(db.items.get('forca|MEMBER#kid1|PROFILE').membership.end, '2026-11-30T21:59:59.999Z');
  assert.deepEqual(stopLog(db).map((l) => l.action), ['now']);
  mock.timers.reset();
  assert.deepEqual(await runDays(db, '2026-11-15', '2027-02-02'), [], 'nothing charged after');
  assert.equal(db.hyp, 0);
});

test('option 1 again on a cancelled subscription is refused', async () => {
  makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': { ...AGREEMENT, status: 'cancelled', token: '' } }));
  setNow(noon('2026-11-14'));
  const res = await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'now', reason: 'שוב' }));
  assert.equal(res.statusCode, 400);
  assert.equal(body(res).error, 'already_cancelled');
});

test('saved card kept when a sibling\'s subscription uses it; the subscription\'s own copy still goes', async () => {
  const db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag2|METADATA': SIBLING }));
  setNow(noon('2026-11-14'));
  const prev = body(await adminForcaSubscriptionStopPreview(ev('admin1', { agreementId: 'ag1', mode: 'now' })));
  assert.equal(prev.savedCard.willDelete, false);
  assert.ok(prev.preview.warnings.some((w: any) => w.code === 'saved_card_kept' && /מאיה כהן/.test(w.message)));
  await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'now', reason: 'ההורה ביקשה' }));
  assert.equal(agreementOf(db).token, '');
  assert.equal(parentOf(db).payment.hypToken, 'tok');
  assert.equal(agreementOf(db, 'ag2').token, 'tok', 'sibling untouched');
  assert.equal(agreementOf(db).cancellation.savedCardDeleted, false);
});

test('option 2 (end of period): December charged, the stop runs Jan 1 before any charge, nothing after', async () => {
  const db = makeDb(seed());
  setNow(noon('2026-11-14'));
  const res = await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'period_end', reason: 'סוף עונה' }));
  assert.equal(res.statusCode, 200);
  assert.equal(agreementOf(db).scheduledStop.stopDay, '2027-01-01');
  assert.equal(agreementOf(db).scheduledStop.byName, 'Or Saraf');
  assert.deepEqual(stopIndex(db), ['forca|FORCA_SCHEDULED_STOP|2027-01-01#ag1']);
  assert.equal(agreementOf(db).token, 'tok', 'card stays until the stop day');
  mock.timers.reset();

  const charged = await runDays(db, '2026-11-15', '2027-04-02');
  assert.deepEqual(charged, ['2026-12-01']);
  const a = agreementOf(db);
  assert.equal(a.status, 'cancelled');
  assert.equal(a.token, '');
  assert.equal(a.scheduledStop, undefined);
  assert.equal(a.cancellation.executedBy, 'scheduler');
  assert.equal(a.cancellation.mode, 'period_end');
  assert.equal(a.cancellation.reason, 'סוף עונה');
  assert.equal(a.cancellation.executedAt.slice(0, 10), '2027-01-01');
  assert.equal(parentOf(db).payment.hypToken, undefined);
  assert.deepEqual(stopIndex(db), []);
  assert.deepEqual(stopLog(db).map((l) => l.action).sort(), ['run', 'schedule']);
  // Paid for December: active until Dec 31.
  const end = new Date(db.items.get('forca|MEMBER#kid1|PROFILE').membership.end);
  assert.equal(end.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }), '2026-12-31');
});

test('option 3 (picked date, Jan → Mar 20): Feb 1 and Mar 1 charged, stopped Mar 20, nothing after', async () => {
  const db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': { ...AGREEMENT, nextChargeDate: '2027-01-31T22:00:00.000Z', GSI3SK: '2027-01-31T22:00:00.000Z' } }));
  setNow(noon('2027-01-10'));
  const prev = body(await adminForcaSubscriptionStopPreview(ev('admin1', { agreementId: 'ag1', mode: 'date', stopDay: '2027-03-20' })));
  assert.deepEqual(prev.preview.remainingCharges.map((c: any) => c.day), ['2027-02-01', '2027-03-01']);
  assert.equal(prev.preview.lastActiveDay, '2027-03-31');
  const res = await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-03-20', reason: 'מעבר דירה' }));
  assert.equal(res.statusCode, 200);
  mock.timers.reset();

  const charged = await runDays(db, '2027-01-11', '2027-10-02');
  assert.deepEqual(charged, ['2027-02-01', '2027-03-01'], 'exactly what the summary said');
  const a = agreementOf(db);
  assert.equal(a.status, 'cancelled');
  assert.equal(a.cancellation.executedAt.slice(0, 10), '2027-03-20');
  assert.equal(a.cancellation.stopDay, '2027-03-20');
});

test('editing a scheduled stop moves it; the old day does nothing; logged', async () => {
  const db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': { ...AGREEMENT, nextChargeDate: '2027-01-31T22:00:00.000Z', GSI3SK: '2027-01-31T22:00:00.000Z' } }));
  setNow(noon('2027-01-10'));
  await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-02-15', reason: 'א' + 'ב' }));
  // The screen's stop no longer matches → conflict, nothing changes.
  const stale = await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-03-20', reason: 'שינוי', expectedStopDay: null }));
  assert.equal(stale.statusCode, 409);
  const res = await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-03-20', reason: 'ההורה ביקשה להמשיך עוד חודש', expectedStopDay: '2027-02-15' }));
  assert.equal(res.statusCode, 200);
  const s = agreementOf(db).scheduledStop;
  assert.equal(s.stopDay, '2027-03-20');
  assert.equal(s.reason, 'ההורה ביקשה להמשיך עוד חודש');
  assert.ok(s.updatedAt);
  assert.deepEqual(stopIndex(db), ['forca|FORCA_SCHEDULED_STOP|2027-03-20#ag1'], 'old index entry gone');
  const log = stopLog(db).sort((x, y) => x.SK.localeCompare(y.SK));
  assert.deepEqual(log.map((l) => l.action), ['schedule', 'update']);
  assert.equal(log[1].before.stopDay, '2027-02-15');
  assert.equal(log[1].after.stopDay, '2027-03-20');
  mock.timers.reset();

  assert.deepEqual(await runDays(db, '2027-01-11', '2027-04-02'), ['2027-02-01', '2027-03-01']);
  assert.equal(agreementOf(db).cancellation.executedAt.slice(0, 10), '2027-03-20');
});

test('editing to "now" runs at once and clears the schedule', async () => {
  const db = makeDb(seed());
  setNow(noon('2026-11-14'));
  await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'period_end', reason: 'סוף עונה' }));
  await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'now', reason: 'עדיף עכשיו' }));
  assert.equal(agreementOf(db).status, 'cancelled');
  assert.equal(agreementOf(db).scheduledStop, undefined);
  assert.deepEqual(stopIndex(db), []);
  mock.timers.reset();
  assert.deepEqual(await runDays(db, '2026-11-15', '2027-01-05'), []);
});

test('removing a scheduled stop: the subscription carries on and is charged as usual', async () => {
  const db = makeDb(seed());
  setNow(noon('2026-11-14'));
  await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'period_end', reason: 'סוף עונה' }));
  const res = await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'remove', expectedStopDay: '2027-01-01' }));
  assert.equal(res.statusCode, 200);
  assert.equal(agreementOf(db).scheduledStop, undefined);
  assert.deepEqual(stopIndex(db), []);
  assert.equal((await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'remove' }))).statusCode, 404);
  mock.timers.reset();
  assert.deepEqual(await runDays(db, '2026-11-15', '2027-02-02'), ['2026-12-01', '2027-01-01', '2027-02-01']);
  assert.equal(agreementOf(db).status, 'active');
  assert.deepEqual(stopLog(db).map((l) => l.action).sort(), ['remove', 'schedule']);
});

test('a stop on a day outside a period still runs that day', async () => {
  const db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': { ...AGREEMENT, nextChargeDate: '2027-05-31T22:00:00.000Z', GSI3SK: '2027-05-31T22:00:00.000Z' } }));
  setNow(noon('2027-05-10'));
  await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-07-15', reason: 'קיץ' }));
  mock.timers.reset();
  assert.deepEqual(await runDays(db, '2027-05-11', '2027-09-02'), ['2027-06-01']);
  assert.equal(agreementOf(db).cancellation.executedAt.slice(0, 10), '2027-07-15');
  assert.equal(agreementOf(db).token, '');
});

test('no charge after the stop day on any path: a stale index read, a retry, a direct charge', async () => {
  // The stop index was never run (say the stop step failed) and the agreement is still listed as due.
  const late = {
    ...AGREEMENT, nextChargeDate: '2026-12-31T22:00:00.000Z', GSI3SK: '2026-12-31T22:00:00.000Z',
    scheduledStop: { mode: 'period_end', stopDay: '2027-01-01', reason: 'סוף עונה', by: 'admin1', byName: 'Or Saraf', at: '2026-11-14T10:00:00.000Z' },
  };
  // 1. Direct charge call on the stop day.
  let db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': late }));
  const r = await chargeOneForcaAgreement(late, at('2027-01-01'));
  assert.equal(r.stopped, true);
  assert.equal(db.hyp, 0);
  assert.equal(agreementOf(db).status, 'cancelled');
  // 2. The job, with the stop index missing (stop step skipped), on a later day — a retry of a failed charge.
  db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': { ...late, consecutiveFailures: 1, nextChargeDate: '2027-01-02T08:00:00.000Z', GSI3SK: '2027-01-02T08:00:00.000Z' } }));
  await runForcaBillingCycle(at('2027-01-03'));
  assert.equal(db.hyp, 0);
  assert.equal(agreementOf(db).status, 'cancelled');
  // 3. The index lags: GSI3 still returns the old copy after the stop ran.
  db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': late, 'forca|FORCA_SCHEDULED_STOP|2027-01-01#ag1': { PK: 'FORCA_SCHEDULED_STOP', SK: '2027-01-01#ag1', agreementId: 'ag1', stopDay: '2027-01-01' } }));
  const realExec = ddb.send;
  ddb.send = (async (cmd: any) => {
    if (cmd.constructor.name === 'QueryCommand' && cmd.input.IndexName === 'GSI3') return { Items: [late] };
    return realExec(cmd);
  }) as typeof ddb.send;
  const res = await runForcaBillingCycle(at('2027-01-01'));
  assert.equal(db.hyp, 0);
  assert.equal(res.succeeded, 0);
  assert.equal(res.stops.stopped, 1);
});

test('a parent cancelling before the stop day: the stop later cleans up, nothing charged', async () => {
  const db = makeDb(seed({
    'forca|FORCAAGREEMENT#ag1|METADATA': { ...AGREEMENT, status: 'cancelled', token: '', GSI3PK: undefined, GSI3SK: undefined, scheduledStop: { mode: 'date', stopDay: '2026-12-10', reason: 'x y', by: 'admin1', byName: 'Or Saraf', at: 'x' } },
    'forca|FORCA_SCHEDULED_STOP|2026-12-10#ag1': { PK: 'FORCA_SCHEDULED_STOP', SK: '2026-12-10#ag1', agreementId: 'ag1', stopDay: '2026-12-10' },
  }));
  await runForcaBillingCycle(at('2026-12-10'));
  assert.equal(db.hyp, 0);
  assert.deepEqual(stopIndex(db), []);
  assert.equal(agreementOf(db).scheduledStop, undefined);
  assert.equal(agreementOf(db).cancellation, undefined, 'the parent\'s cancel stays as it was');
});

test('end-of-period notice: not sent for a subscription that stops before the next period', async () => {
  const stopped = { ...AGREEMENT, scheduledStop: { mode: 'period_end', stopDay: '2027-01-01', reason: 'סוף עונה', by: 'admin1', byName: 'Or Saraf', at: 'x' } };
  let db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': stopped }));
  let res = await runPeriodEndReminders(noon('2026-12-10'));
  assert.equal(res.sent, 0);
  assert.equal(db.push, 0);
  // A stop later than the next period's start: the next period does continue, so the notice goes out.
  db = makeDb(seed({ 'forca|FORCAAGREEMENT#ag1|METADATA': { ...stopped, scheduledStop: { ...stopped.scheduledStop, stopDay: '2027-03-20' } } }));
  res = await runPeriodEndReminders(noon('2026-12-10'));
  assert.equal(res.sent, 1);
});

test('agreements list: shows the scheduled stop and the cancellation record', async () => {
  makeDb(seed());
  setNow(noon('2026-11-14'));
  await adminForcaSubscriptionStop(ev('admin1', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-03-20', reason: 'מעבר דירה' }));
  const list = body(await listAgreements(ev('admin1', {})));
  assert.equal(list.agreements[0].scheduledStop.stopDay, '2027-03-20');
  assert.equal(list.agreements[0].cancellation, null);
});
