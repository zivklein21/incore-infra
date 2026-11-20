// Run: npm test
// FORCA cancellation requests — the parent's choice (lawyer's update, 2026-11-20):
//   א end_of_paid_month: the stop is scheduled by itself for the 1st of next
//     month (marked "נקבע אוטומטית…"), the parent sees the end date at once;
//     an existing stop is never changed (a later one is highlighted for Or);
//   ב early_legal: highlighted and first for Or; she sets the legal date D,
//     charges stop, access ends at D, refund suggested for after D, never automatic;
//   ג unsure (and nothing picked, and older requests): Or reviews, 5.8 only a hint.
// Plus: the receipt holds the choice, and the distance-sale warning (14ג/14ה).
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const sentEmails: any[] = [];
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === '@aws-sdk/client-sesv2') {
    return {
      SESv2Client: class { async send(cmd: any) { sentEmails.push(cmd.input); return {}; } },
      SendEmailCommand: class { input: any; constructor(input: any) { this.input = input; } },
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { ddb } = require('../src/lib/dynamo');
const rules = require('../src/lib/forcaCancelRequests/rules');
const { adminForcaCancelRequest, adminForcaCancelRequests, getMyForcaCancelRequests, submitForcaCancelRequest } = require('../src/lib/forcaCancelRequests/handlers');
const { adminForcaSubscriptionStop, adminForcaSubscriptionStopPreview } = require('../src/lib/forcaSubscriptionStop/handlers');
const { adminForcaRefunds } = require('../src/lib/forcaRefunds/handlers');
const { israelEndOfDayIso } = require('../src/lib/forcaSubscriptionStop/access');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; mock.timers.reset(); sentEmails.length = 0; });
const setNow = (iso: string) => { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() }); };

// ── A small in-memory table ─────────────────────────────────────────────────

type Db = { items: Map<string, any>; pushes: any[] };
const keyOf = (table: string, k: any) => `${table}|${k.PK}|${k.SK}`;
const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const getPath = (o: any, p: string[]) => p.reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o: any, p: string[], v: any) { let x = o; for (const k of p.slice(0, -1)) { if (x[k] == null || typeof x[k] !== 'object') x[k] = {}; x = x[k]; } x[p[p.length - 1]] = v; }
function removePath(o: any, p: string[]) { const parent = getPath(o, p.slice(0, -1)); if (parent) delete parent[p[p.length - 1]]; }
const pathOf = (raw: string, names: any = {}) => raw.trim().split('.').map((p) => names[p] ?? p);

function applyUpdate(item: any, expr: string, names: any = {}, values: any = {}) {
  const re = /\b(SET|REMOVE|ADD)\b/g;
  const parts: { kw: string; body: string }[] = [];
  let m: RegExpExecArray | null; let last: { kw: string; start: number } | null = null;
  while ((m = re.exec(expr))) { if (last) parts.push({ kw: last.kw, body: expr.slice(last.start, m.index) }); last = { kw: m[1], start: m.index + m[0].length }; }
  if (last) parts.push({ kw: last.kw, body: expr.slice(last.start) });
  for (const { kw, body } of parts) {
    for (const clause of body.split(',').map((c) => c.trim()).filter(Boolean)) {
      if (kw === 'SET') { const [l, r] = clause.split('='); setPath(item, pathOf(l, names), clone(values[r.trim()])); }
      else if (kw === 'REMOVE') removePath(item, pathOf(clause, names));
      else { const [l, r] = clause.split(/\s+/); const p = pathOf(l, names); setPath(item, p, (getPath(item, p) ?? 0) + values[r]); }
    }
  }
}

function checkCondition(item: any, cond: string | undefined, names: any = {}, v: any = {}): boolean {
  if (!cond) return true;
  const st = item ? item.status : undefined;
  switch (cond) {
    case 'attribute_not_exists(PK)': return !item;
    case 'version = :v': return !!item && item.version === v[':v'];
    case 'attribute_not_exists(PK) OR version = :v': return !item || item.version === v[':v'];
    case 'attribute_exists(PK) AND #status <> :cancelled': return !!item && st !== v[':cancelled'];
    case '#status IN (:active, :frozen) AND scheduledStop.stopDay = :prev': return !!item && [v[':active'], v[':frozen']].includes(st) && item.scheduledStop?.stopDay === v[':prev'];
    case '#status IN (:active, :frozen) AND attribute_not_exists(scheduledStop)': return !!item && [v[':active'], v[':frozen']].includes(st) && !item.scheduledStop;
    case 'scheduledStop.stopDay = :prev': return item?.scheduledStop?.stopDay === v[':prev'];
    case 'payment.hypToken = :card': return item?.payment?.hypToken === v[':card'];
    case 'membership.#end = :cut': return item?.membership?.end === v[':cut'];
    default: throw new Error(`test db: unknown condition ${cond}`);
  }
}
const condFail = (name = 'ConditionalCheckFailedException') => { const e = new Error('condition'); (e as any).name = name; return e; };

function makeDb(seed: Record<string, any>): Db {
  const db: Db = { items: new Map(Object.entries(clone(seed))), pushes: [] };
  const all = (table: string) => [...db.items.entries()].filter(([k]) => k.startsWith(`${table}|`)).map(([, v]) => v);
  const exec = (name: string, input: any): any => {
    const v = input.ExpressionAttributeValues ?? {};
    const names = input.ExpressionAttributeNames ?? {};
    if (name === 'GetCommand') return { Item: clone(db.items.get(keyOf(input.TableName, input.Key))) };
    if (name === 'PutCommand') {
      const k = keyOf(input.TableName, input.Item);
      if (!checkCondition(db.items.get(k), input.ConditionExpression, names, v)) throw condFail();
      db.items.set(k, clone(input.Item)); return {};
    }
    if (name === 'DeleteCommand') { db.items.delete(keyOf(input.TableName, input.Key)); return {}; }
    if (name === 'UpdateCommand') {
      const k = keyOf(input.TableName, input.Key);
      const cur = db.items.get(k);
      if (!checkCondition(cur, input.ConditionExpression, names, v)) throw condFail();
      const item = cur ?? { ...input.Key };
      applyUpdate(item, input.UpdateExpression, names, v);
      db.items.set(k, item); return {};
    }
    if (name === 'QueryCommand') {
      let rows = all(input.TableName);
      const kc: string = input.KeyConditionExpression;
      if (input.IndexName === 'GSI1') {
        rows = rows.filter((r) => r.GSI1PK === v[':pk'] && (!v[':prefix'] || String(r.GSI1SK).startsWith(v[':prefix'])));
        rows.sort((a, b) => (input.ScanIndexForward === false ? b.GSI1SK.localeCompare(a.GSI1SK) : a.GSI1SK.localeCompare(b.GSI1SK)));
      } else if (input.IndexName === 'GSI2') {
        rows = rows.filter((r) => r.GSI2PK === v[':pk'] && (v[':g'] === undefined || r.groupId === v[':g'])).sort((a, b) => b.GSI2SK.localeCompare(a.GSI2SK));
      } else if (/SK <= :upTo/.test(kc)) {
        rows = rows.filter((r) => r.PK === v[':pk'] && r.SK <= v[':upTo']);
      } else if (/begins_with\(SK, :prefix\)/.test(kc)) {
        rows = rows.filter((r) => r.PK === v[':pk'] && String(r.SK).startsWith(v[':prefix'])).sort((a, b) => a.SK.localeCompare(b.SK));
      } else if (kc === 'PK = :pk') {
        rows = rows.filter((r) => r.PK === v[':pk']);
      } else rows = [];
      return { Items: clone(rows) };
    }
    if (name === 'ScanCommand') {
      let rows = all(input.TableName);
      if (v[':gid'] !== undefined) rows = rows.filter((r) => r.SK === 'METADATA' && r.groupId === v[':gid'] && r.date >= v[':now']);
      else if (v[':g'] !== undefined) rows = rows.filter((r) => String(r.PK).startsWith(v[':prefix']) && r.SK === v[':m'] && r.groupId === v[':g']);
      else rows = [];
      return { Items: clone(rows) };
    }
    if (name === 'TransactWriteCommand') {
      for (const t of input.TransactItems) {
        const [, body] = Object.entries(t)[0] as [string, any];
        if (!checkCondition(db.items.get(keyOf(body.TableName, body.Key ?? body.Item)), body.ConditionExpression, body.ExpressionAttributeNames, body.ExpressionAttributeValues)) throw condFail('TransactionCanceledException');
      }
      for (const t of input.TransactItems) {
        const [op, body] = Object.entries(t)[0] as [string, any];
        const k = keyOf(body.TableName, body.Key ?? body.Item);
        if (op === 'Put') db.items.set(k, clone(body.Item));
        else if (op === 'Delete') db.items.delete(k);
        else { const item = db.items.get(k) ?? { ...body.Key }; applyUpdate(item, body.UpdateExpression, body.ExpressionAttributeNames, body.ExpressionAttributeValues); db.items.set(k, item); }
      }
      return {};
    }
    throw new Error(`test db: unexpected ${name}`);
  };
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => exec(cmd.constructor.name, cmd.input)) as typeof ddb.send;
  globalThis.fetch = (async (_url: string, init: any) => {
    const parsed = JSON.parse(init?.body ?? '[]');
    db.pushes.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'r' }] }), text: async () => '' };
  }) as unknown as typeof fetch;
  return db;
}

// ── Seed ────────────────────────────────────────────────────────────────────

const OR = { PK: 'MEMBER#or', SK: 'PROFILE', role: 'admin', GSI1PK: 'ROLE#admin', GSI1SK: 'x', identity: { role: 'admin', first_name: 'Or', last_name: 'Saraf' }, expoPushToken: 'ExponentPushToken[or]' };
const PERIODS = [
  { id: 'p0', name: 'ספטמבר–דצמבר', start: '2026-09-01', end: '2026-12-31' },
  { id: 'p1', name: 'ינואר–יוני', start: '2027-01-01', end: '2027-06-30' },
  { id: 'p2', name: 'ספטמבר', start: '2027-09-01', end: '2027-12-31' },
];
const JAN_END = israelEndOfDayIso('2027-01-31');
function agreement(extra: Record<string, any> = {}) {
  return {
    PK: 'FORCAAGREEMENT#ag1', SK: 'METADATA', agreementId: 'ag1', userId: 'kid1', payerUid: 'mom', payerName: 'דנה כהן',
    GSI1PK: 'MEMBER#kid1', GSI1SK: 'AGREEMENT#ag1', GSI2PK: 'FORCAAGREEMENT', GSI2SK: 'x',
    status: 'active', productName: 'חודשי', groupId: 'g1', groupName: 'בנות 10', token: 'tok', amountPerCharge: 250,
    nextChargeDate: '2027-01-31T22:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', ...extra,
  };
}
const order = (id: string, at: string) => ({
  [`forca|FORCASUBORDER#${id}|METADATA`]: { PK: `FORCASUBORDER#${id}`, SK: 'METADATA', GSI1PK: 'MEMBER#kid1', GSI1SK: `FORCASUBORDER#${at}#${id}`, orderId: id, userId: 'kid1', status: 'completed', amount: 250, productName: 'חודשי', createdAt: at, hypTransactionId: `t-${id}` },
});
/** A group session (and kid1 on it) at 17:00 Israel on `day`. */
function session(day: string, onRoster = true) {
  const id = `c-${day}`;
  const date = new Date(`${day}T15:00:00.000Z`).toISOString();
  return {
    [`forca|CLASS#${id}|METADATA`]: { PK: `CLASS#${id}`, SK: 'METADATA', GSI2PK: `CLASSDATE#${day}`, GSI2SK: date, groupId: 'g1', date, allowedMemberIds: onRoster ? ['kid1', 'other'] : ['other'], capacity: 2, currentAttendeesCount: 2 },
    ...(onRoster ? { [`forca|CLASS#${id}|REG#kid1`]: { PK: `CLASS#${id}`, SK: 'REG#kid1', GSI1PK: 'MEMBER#kid1', GSI1SK: `REG##${id}`, classId: id, classDate: date, userId: 'kid1' } } : {}),
  };
}
function seed(extra: Record<string, any> = {}, opts: { agreement?: any; firstPayment?: string } = {}) {
  return {
    'incore|MEMBER#or|PROFILE': OR,
    'forca|APPCONFIG|FORCA_ACTIVITY_PERIODS': { PK: 'APPCONFIG', SK: 'FORCA_ACTIVITY_PERIODS', periods: PERIODS },
    'forca|MEMBER#mom|PROFILE': { PK: 'MEMBER#mom', SK: 'PROFILE', identity: { first_name: 'דנה', last_name: 'כהן', email: 'dana@example.com' }, expoPushToken: 'ExponentPushToken[mom]' },
    'forca|MEMBER#mom|FAMILY#kid1': { PK: 'MEMBER#mom', SK: 'FAMILY#kid1', GSI1PK: 'MEMBER#kid1', GSI1SK: 'FAMILYOF#mom', parentUid: 'mom', childUid: 'kid1', childName: 'נועה' },
    'forca|MEMBER#kid1|PROFILE': { PK: 'MEMBER#kid1', SK: 'PROFILE', identity: { first_name: 'נועה', last_name: 'כהן', groupId: 'g1' }, membership: { title: 'FORCA', start: '2026-10-01T00:00:00.000Z', end: JAN_END } },
    ...(opts.agreement === null ? {} : { 'forca|FORCAAGREEMENT#ag1|METADATA': opts.agreement ?? agreement() }),
    ...order('first', opts.firstPayment ?? '2026-10-01T09:00:00.000Z'),
    ...order('jan', '2027-01-01T01:30:00.000Z'),
    ...extra,
  };
}

const ev = (uid: string, body: unknown) => ({ body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { sub: uid } } } } }) as any;
const call = async (fn: any, uid: string, body: unknown) => { const r = await fn(ev(uid, body)); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const receiptOf = (db: Db, id: string) => db.items.get(`forca|FORCACANCELREQ#${id}|RECEIPT`);
const stateOf = (db: Db, id: string) => db.items.get(`forca|FORCACANCELREQ#${id}|STATE`);
const logOf = (db: Db, id: string) => [...db.items.values()].filter((i) => i.PK === `FORCACANCELREQ#${id}` && String(i.SK).startsWith('LOG#')).sort((a, b) => a.SK.localeCompare(b.SK));
const agreementOf = (db: Db) => db.items.get('forca|FORCAAGREEMENT#ag1|METADATA');
const kid = (db: Db) => db.items.get('forca|MEMBER#kid1|PROFILE');
const stopLog = (db: Db) => [...db.items.values()].filter((i) => i.PK === 'FORCAAGREEMENT#ag1' && String(i.SK).startsWith('STOPLOG#')).sort((a, b) => a.SK.localeCompare(b.SK));
const messageOf = (db: Db, id: string) => db.items.get(`forca|MEMBER#mom|MESSAGE#forcacancelreq_${id}`).body as string;
const noRefunds = (db: Db) => assert.ok(![...db.items.keys()].some((k) => k.includes('FORCAREFUND#')), 'nothing refunded automatically');
const submit = (db: Db, body: Record<string, unknown>) => call(submitForcaCancelRequest, 'mom', { childUid: 'kid1', ...body });

// ── Rules ───────────────────────────────────────────────────────────────────

test('rules — the choice is optional: nothing (or an older app) is ג; unknown values are refused', () => {
  assert.deepEqual(rules.parseChoice(undefined), { choice: 'unsure', source: 'default' });
  assert.deepEqual(rules.parseChoice(''), { choice: 'unsure', source: 'default' });
  assert.deepEqual(rules.parseChoice('end_of_paid_month'), { choice: 'end_of_paid_month', source: 'parent' });
  assert.deepEqual(rules.parseChoice('unsure'), { choice: 'unsure', source: 'parent' });
  assert.equal(rules.parseChoice('cancel_now'), null);
  // Stored requests from before the choice count as ג; a medical freeze has none.
  assert.equal(rules.choiceOf({}), 'unsure');
  assert.equal(rules.choiceOf({ type: 'medical_freeze' }), null);
  assert.equal(rules.suggestionUseFor('end_of_paid_month'), 'preselect');
  assert.equal(rules.suggestionUseFor('early_legal'), 'none');
  assert.equal(rules.suggestionUseFor('unsure'), 'hint');
});

test('rules — fixed wording for each choice, the date only when the stop is set', () => {
  assert.equal(rules.choiceRequestLine('early_legal'), 'בחירתי: בקשה לביטול מוקדם לפי דין.');
  assert.match(rules.choiceConfirmationLine('end_of_paid_month', '2027-01-31'), /פעילה עד 31\/01\/2027, ולא יבוצע חיוב לחודש הבא\. אין החזר על החודש הנוכחי/);
  assert.doesNotMatch(rules.choiceConfirmationLine('end_of_paid_month', null), /\d\d\/\d\d\/\d{4}/);
  assert.match(rules.choiceConfirmationLine('early_legal', null), /לפי דין/);
  assert.match(rules.choiceConfirmationLine('unsure', null), /לבירור/);
});

test('rules — existing stop: later than the parent\'s end is highlighted, earlier or the same is a note', () => {
  const later = rules.existingStopOutcome('2027-03-01', '2027-02-01', '2027-01-31');
  assert.equal(later.highlight, true);
  assert.equal(later.message, 'ההורה בחר/ה לסיים ב-31/01 – קיימת עצירה מאוחרת יותר, לבדוק');
  for (const day of ['2027-02-01', '2027-01-20']) {
    const o = rules.existingStopOutcome(day, '2027-02-01', '2027-01-31');
    assert.equal(o.highlight, false);
    assert.match(o.message, /קיימת כבר עצירה/);
  }
});

test('rules — legal date D: not before receipt; D today or earlier stops now; later stops on D+1', () => {
  assert.deepEqual(rules.legalDateToStop('2027-01-11', '2027-01-12', '2027-01-14'), { ok: false, error: 'legal_day_before_receipt' });
  assert.deepEqual(rules.legalDateToStop('12/01/2027', '2027-01-12', '2027-01-14'), { ok: false, error: 'invalid_legal_day' });
  assert.deepEqual(rules.legalDateToStop('2027-01-12', '2027-01-12', '2027-01-14'), { ok: true, legalDay: '2027-01-12', mode: 'now', stopDay: '2027-01-14' });
  assert.deepEqual(rules.legalDateToStop('2027-01-14', '2027-01-12', '2027-01-14'), { ok: true, legalDay: '2027-01-14', mode: 'now', stopDay: '2027-01-14' });
  assert.deepEqual(rules.legalDateToStop('2027-01-20', '2027-01-12', '2027-01-14'), { ok: true, legalDay: '2027-01-20', mode: 'date', stopDay: '2027-01-21' });
});

test('rules — distance sale: within 14 days of the first payment, before the service started, or no payment', () => {
  const pay = '2027-01-01T08:00:00.000Z';
  assert.deepEqual(rules.distanceSaleCheck('2027-01-15T10:00:00.000Z', pay, PERIODS).reasons, ['within_14_days']);
  assert.equal(rules.distanceSaleCheck('2027-01-16T10:00:00.000Z', pay, PERIODS).warn, false);
  // 23:30 on Jan 15 UTC is Jan 16 in Israel: day 15, no warning.
  assert.equal(rules.distanceSaleCheck('2027-01-15T22:30:00.000Z', pay, PERIODS).warn, false);
  // Paid in the summer break: the service starts Sep 1.
  const summer = rules.distanceSaleCheck('2027-08-30T10:00:00.000Z', '2027-08-01T10:00:00.000Z', PERIODS);
  assert.deepEqual(summer.reasons, ['before_service_start']);
  assert.equal(summer.serviceStartDay, '2027-09-01');
  assert.equal(summer.message, 'בקשה סמוכה להרשמה – לבדוק ביטול עסקת מכר מרחוק (סעיפים 14ג, 14ה)');
  assert.equal(rules.distanceSaleCheck('2027-09-02T10:00:00.000Z', '2027-08-01T10:00:00.000Z', PERIODS).warn, false);
  assert.deepEqual(rules.distanceSaleCheck('2027-01-15T10:00:00.000Z', null, PERIODS).reasons, ['no_payment']);
  assert.equal(rules.firstPaymentOf([{ orderId: 'b', amount: 1, createdAt: '2027-02-01T00:00:00Z' }, { orderId: 'a', amount: 1, createdAt: '2027-01-01T00:00:00Z', status: 'failed' }, { orderId: 'c', amount: 1, createdAt: '2027-01-15T00:00:00Z' }]), '2027-01-15T00:00:00Z');
});

// ── Option א ────────────────────────────────────────────────────────────────

test('א: the stop is set by itself for the 1st of next month; the parent sees the end date at once; nothing refunded', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const parentView = await call(getMyForcaCancelRequests, 'mom', {});
  assert.deepEqual(parentView.body.choices.map((c: any) => c.value), ['end_of_paid_month', 'early_legal', 'unsure']);

  const r = await submit(db, { choice: 'end_of_paid_month' });
  assert.equal(r.status, 200);
  const id = r.body.request.requestId;
  assert.equal(r.body.request.statusLabel, 'מועד סיום שנקבע: 31/01/2027');
  assert.equal(r.body.request.choiceLabel, 'סיום בתום החודש ששולם');

  // The receipt holds the choice, written once, in the hash.
  const rec = receiptOf(db, id);
  assert.equal(rec.receivedAt, '2027-01-12T08:15:00.000Z');
  assert.equal(rec.choice, 'end_of_paid_month');
  assert.equal(rec.choiceSource, 'parent');
  assert.match(rec.content.requestText, /\nבחירתי: סיום בתום החודש ששולם\.$/);
  const { PK: _p, SK: _s, contentHash, ...body } = rec;
  assert.equal(contentHash, rules.receiptHash(body));

  // The stop: the existing logic, marked as automatic.
  const stop = agreementOf(db).scheduledStop;
  assert.equal(stop.stopDay, '2027-02-01');
  assert.equal(stop.mode, 'date');
  assert.equal(stop.auto, true);
  assert.equal(stop.by, 'system');
  assert.equal(stop.reason, 'נקבע אוטומטית לפי בחירת ההורה (סעיף 5.8)');
  assert.equal(stop.parentRequestId, id);
  assert.ok(db.items.get('forca|FORCA_SCHEDULED_STOP|2027-02-01#ag1'));
  assert.deepEqual(stopLog(db).map((l) => [l.action, l.by]), [['schedule', 'system']]);
  assert.equal(agreementOf(db).status, 'active');

  const st = stateOf(db, id);
  assert.equal(st.status, 'end_date_set');
  assert.equal(st.endDate, '2027-01-31');
  assert.equal(st.autoStop.result, 'scheduled');
  assert.deepEqual(logOf(db, id).map((l) => [l.action, l.by.system ?? l.by.uid]), [['received', 'mom'], ['end_date_from_stop', 'parent_choice'], ['parent_notified', 'confirmation']]);
  assert.match(messageOf(db, id), /ההשתתפות פעילה עד 31\/01\/2027, ולא יבוצע חיוב לחודש הבא\. אין החזר על החודש הנוכחי\./);
  assert.match(sentEmails[0].Content.Simple.Body.Html.Data, /בחירת ההורה/);
  noRefunds(db);
});

test('א: Or edits the automatic stop from the subscription card (the request follows), then removes it; all logged', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const id = (await submit(db, { choice: 'end_of_paid_month' })).body.request.requestId;
  setNow('2027-01-14T10:00:00.000Z');
  // From the card: no parentRequestId sent, the stop keeps it.
  const edit = await call(adminForcaSubscriptionStop, 'or', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-03-01', reason: 'ההורה ביקשה עוד חודש', expectedStopDay: '2027-02-01' });
  assert.equal(edit.status, 200);
  assert.equal(agreementOf(db).scheduledStop.parentRequestId, id);
  assert.equal(agreementOf(db).scheduledStop.auto, undefined);
  assert.equal(stateOf(db, id).endDate, '2027-02-28');
  const rm = await call(adminForcaSubscriptionStop, 'or', { agreementId: 'ag1', action: 'remove', expectedStopDay: '2027-03-01' });
  assert.equal(rm.status, 200);
  assert.equal(stateOf(db, id).status, 'in_progress');
  // Same frozen clock: compare without order.
  assert.deepEqual(stopLog(db).map((l) => `${l.action}:${l.by}`).sort(), ['remove:or', 'schedule:system', 'update:or']);
  assert.deepEqual(logOf(db, id).map((l) => l.action).slice(-2), ['end_date_from_stop', 'stop_removed']);
});

test('א with a LATER stop already scheduled: nothing changes, highlighted for Or; no date promised', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const existing = { mode: 'date', stopDay: '2027-04-01', reason: 'בקשה בטלפון', by: 'or', byName: 'Or', at: '2027-01-02T10:00:00.000Z' };
  const db = makeDb(seed({}, { agreement: agreement({ scheduledStop: existing }) }));
  const r = await submit(db, { choice: 'end_of_paid_month' });
  const id = r.body.request.requestId;
  assert.deepEqual(agreementOf(db).scheduledStop, existing);
  assert.equal(r.body.request.statusLabel, 'הבקשה התקבלה');
  const st = stateOf(db, id);
  assert.equal(st.autoStop.reason, 'existing_stop');
  assert.equal(st.autoStop.highlight, true);
  const list = await call(adminForcaCancelRequests, 'or', {});
  assert.deepEqual(list.body.requests[0].autoStopNote, { message: 'ההורה בחר/ה לסיים ב-31/01 – קיימת עצירה מאוחרת יותר, לבדוק', highlight: true });
  assert.doesNotMatch(messageOf(db, id), /פעילה עד/);
  assert.ok(logOf(db, id).some((l) => l.action === 'auto_stop_skipped'));
});

test('א with an earlier or the same stop: nothing changes, just a note', async () => {
  for (const day of ['2027-02-01', '2027-01-20']) {
    setNow('2027-01-12T08:15:00.000Z');
    const existing = { mode: 'date', stopDay: day, reason: 'x', by: 'or', byName: 'Or', at: '2027-01-02T10:00:00.000Z' };
    const db = makeDb(seed({}, { agreement: agreement({ scheduledStop: existing }) }));
    const id = (await submit(db, { choice: 'end_of_paid_month' })).body.request.requestId;
    assert.deepEqual(agreementOf(db).scheduledStop, existing);
    assert.equal(stateOf(db, id).autoStop.highlight, false);
    assert.match(stateOf(db, id).autoStop.message, /קיימת כבר עצירה/);
  }
});

test('א with no running subscription: received, nothing scheduled, flagged for Or', async () => {
  for (const [ag, reason] of [[agreement({ status: 'cancelled' }), 'not_active'], [null, 'no_subscription']] as const) {
    setNow('2027-01-12T08:15:00.000Z');
    const db = makeDb(seed({}, { agreement: ag }));
    const r = await submit(db, { choice: 'end_of_paid_month' });
    assert.equal(r.status, 200);
    assert.equal(r.body.request.statusLabel, 'הבקשה התקבלה');
    assert.equal(stateOf(db, r.body.request.requestId).autoStop.reason, reason);
    assert.ok(!db.items.has('forca|FORCA_SCHEDULED_STOP|2027-02-01#ag1'));
  }
});

// ── Option ב ────────────────────────────────────────────────────────────────

test('ב: highlighted and first for Or; no 5.8 date; Or must set the legal date', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const legal = (await submit(db, { choice: 'early_legal' })).body.request.requestId;
  setNow('2027-01-13T08:15:00.000Z');
  const later = (await submit(db, {})).body.request.requestId;
  assert.equal(agreementOf(db).scheduledStop, undefined);
  assert.ok(db.pushes.some((p) => /ביטול מוקדם לפי דין – נדרשת בדיקה/.test(p.body ?? '')) || [...db.items.values()].some((i) => /ביטול מוקדם לפי דין – נדרשת בדיקה/.test(i.message ?? '')));

  const list = (await call(adminForcaCancelRequests, 'or', {})).body.requests;
  assert.deepEqual(list.map((r: any) => r.requestId), [legal, later]);
  assert.equal(list[0].flag, 'ביטול מוקדם לפי דין – נדרשת בדיקה');
  assert.equal(list[1].flag, null);

  const p = await call(adminForcaSubscriptionStopPreview, 'or', { agreementId: 'ag1', parentRequestId: legal });
  assert.equal(p.body.request.suggestionUse, 'none');
  assert.equal(p.body.request.choice, 'early_legal');
  const noDay = await call(adminForcaSubscriptionStop, 'or', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-02-01', reason: 'בדיקה', parentRequestId: legal });
  assert.deepEqual([noDay.status, noDay.body.error], [400, 'legal_day_required']);
  const before = await call(adminForcaSubscriptionStopPreview, 'or', { agreementId: 'ag1', parentRequestId: legal, legalEffectiveDay: '2027-01-11' });
  assert.deepEqual([before.status, before.body.error], [400, 'legal_day_before_receipt']);
  assert.equal(agreementOf(db).scheduledStop, undefined);
});

test('ב: legal date ahead — summary first (access ends at D, refund for after D), then charges stop on D+1, access ends at D, no refund by itself', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const sessions = { ...session('2027-01-18'), ...session('2027-01-22'), ...session('2027-01-27'), ...session('2027-01-29', false) };
  const db = makeDb(seed(sessions));
  const id = (await submit(db, { choice: 'early_legal' })).body.request.requestId;
  setNow('2027-01-14T10:00:00.000Z');

  const p = await call(adminForcaSubscriptionStopPreview, 'or', { agreementId: 'ag1', parentRequestId: id, legalEffectiveDay: '2027-01-20' });
  assert.equal(p.status, 200);
  assert.equal(p.body.preview.mode, 'date');
  assert.equal(p.body.preview.stopDay, '2027-01-21');
  assert.equal(p.body.preview.lastActiveDay, '2027-01-20');
  assert.equal(p.body.legal.accessEnds, '2027-01-20');
  assert.equal(p.body.legal.paidThroughDay, '2027-01-31');
  assert.equal(p.body.legal.sessionsRemoved, 2);
  assert.equal(p.body.preview.warnings[0].code, 'access_cut');
  assert.match(p.body.preview.warnings[0].message, /תסתיים ב-20\/01\/2027.*2 אימונים/);
  // Group sessions after D up to the paid end (Jan 22, 27, 29) × 62.5.
  assert.deepEqual([p.body.legal.refundSuggestion.sessions, p.body.legal.refundSuggestion.amount], [3, 187.5]);
  // The summary saved nothing.
  assert.equal(agreementOf(db).scheduledStop, undefined);
  assert.equal(kid(db).membership.end, JAN_END);

  const a = await call(adminForcaSubscriptionStop, 'or', { agreementId: 'ag1', action: 'apply', reason: 'ביטול לפי דין', parentRequestId: id, legalEffectiveDay: '2027-01-20' });
  assert.equal(a.status, 200);
  const stop = agreementOf(db).scheduledStop;
  assert.equal(stop.stopDay, '2027-01-21');
  assert.deepEqual([stop.accessCut.legalDay, stop.accessCut.previousEnd], ['2027-01-20', JAN_END]);
  // Access ends at D: membership end, and off the sessions after it (not the one before).
  assert.equal(kid(db).membership.end, israelEndOfDayIso('2027-01-20'));
  assert.equal(kid(db).membership.start, '2026-10-01T00:00:00.000Z');
  assert.ok(db.items.has('forca|CLASS#c-2027-01-18|REG#kid1'));
  assert.ok(!db.items.has('forca|CLASS#c-2027-01-22|REG#kid1'));
  assert.ok(!db.items.has('forca|CLASS#c-2027-01-27|REG#kid1'));
  assert.deepEqual(db.items.get('forca|CLASS#c-2027-01-22|METADATA').allowedMemberIds, ['other']);
  // The request: end date D, the parent sees it.
  const st = stateOf(db, id);
  assert.deepEqual([st.status, st.endDate, st.legalEnd.legalDay, st.legalEnd.paidThroughDay], ['end_date_set', '2027-01-20', '2027-01-20', '2027-01-31']);
  const mine = await call(getMyForcaCancelRequests, 'mom', {});
  assert.equal(mine.body.requests[0].statusLabel, 'מועד סיום שנקבע: 20/01/2027');
  assert.equal(a.body.legal.refundSuggestion.amount, 187.5);
  // The refund sheet opened from the request uses the same window.
  const r = await call(adminForcaRefunds, 'or', { traineeId: 'kid1', agreementId: 'ag1', parentRequestId: id });
  assert.deepEqual([r.body.suggestion.basis, r.body.suggestion.sessions, r.body.suggestion.fromDay, r.body.suggestion.toDay], ['legal_end', 3, '2027-01-21', '2027-01-31']);
  noRefunds(db);
  assert.ok(logOf(db, id).some((l) => l.action === 'legal_end_set' && l.details.sessionsRemoved === 2));

  // Removing the stop gives the access back.
  const rm = await call(adminForcaSubscriptionStop, 'or', { agreementId: 'ag1', action: 'remove', expectedStopDay: '2027-01-21' });
  assert.equal(rm.status, 200);
  assert.equal(kid(db).membership.end, JAN_END);
  assert.equal(kid(db).membership.endedEarly, undefined);
  assert.ok(db.items.has('forca|CLASS#c-2027-01-22|REG#kid1'));
  assert.deepEqual([stateOf(db, id).status, stateOf(db, id).legalEnd], ['in_progress', null]);
});

test('ב: legal date already passed — charges stop now, access ends at D', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed(session('2027-01-22')));
  const id = (await submit(db, { choice: 'early_legal' })).body.request.requestId;
  setNow('2027-01-19T10:00:00.000Z');
  const a = await call(adminForcaSubscriptionStop, 'or', { agreementId: 'ag1', action: 'apply', reason: 'ביטול לפי דין', parentRequestId: id, legalEffectiveDay: '2027-01-15' });
  assert.equal(a.status, 200);
  assert.equal(agreementOf(db).status, 'cancelled');
  assert.equal(agreementOf(db).cancellation.accessCut.legalDay, '2027-01-15');
  assert.equal(kid(db).membership.end, israelEndOfDayIso('2027-01-15'));
  assert.ok(!db.items.has('forca|CLASS#c-2027-01-22|REG#kid1'));
  assert.equal(stateOf(db, id).endDate, '2027-01-15');
  noRefunds(db);
});

// ── Option ג ────────────────────────────────────────────────────────────────

test('ג (picked, or nothing picked): Or reviews; 5.8 only as a hint; nothing scheduled', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const picked = (await submit(db, { choice: 'unsure' })).body.request;
  const none = (await submit(db, {})).body.request;
  assert.equal(receiptOf(db, picked.requestId).choiceSource, 'parent');
  assert.equal(receiptOf(db, none.requestId).choiceSource, 'default');
  for (const r of [picked, none]) {
    assert.equal(r.statusLabel, 'הבקשה התקבלה');
    assert.equal(r.choice, 'unsure');
    assert.match(messageOf(db, r.requestId), /נחזור אלייך לבירור/);
  }
  assert.equal(agreementOf(db).scheduledStop, undefined);
  const p = await call(adminForcaSubscriptionStopPreview, 'or', { agreementId: 'ag1', parentRequestId: none.requestId });
  assert.equal(p.body.request.suggestionUse, 'hint');
  assert.equal(p.body.request.suggestedStopDay, '2027-02-01');
  const bad = await submit(db, { choice: 'whatever' });
  assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_choice']);
});

test('older requests stored without a choice behave as ג', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const id = (await submit(db, {})).body.request.requestId;
  // As written before the update: no choice fields at all.
  for (const k of [`forca|FORCACANCELREQ#${id}|RECEIPT`, `forca|FORCACANCELREQ#${id}|STATE`]) {
    const item = db.items.get(k); delete item.choice; delete item.choiceSource; delete item.distanceSale;
  }
  const row = (await call(adminForcaCancelRequests, 'or', {})).body.requests[0];
  assert.deepEqual([row.choice, row.flag, row.distanceSaleWarning], ['unsure', null, null]);
  const d = await call(adminForcaCancelRequests, 'or', { requestId: id });
  assert.equal(d.body.suggestion.use, 'hint');
  assert.equal((await call(getMyForcaCancelRequests, 'mom', {})).body.requests[0].choice, 'unsure');
  // Or can still stop on the 5.8 date the usual way.
  const a = await call(adminForcaSubscriptionStop, 'or', { agreementId: 'ag1', action: 'apply', mode: 'date', stopDay: '2027-02-01', reason: 'בדיקה', parentRequestId: id });
  assert.equal(a.status, 200);
  assert.equal(stateOf(db, id).endDate, '2027-01-31');
});

// ── Distance sale ───────────────────────────────────────────────────────────

test('distance sale: warned on a request within 14 days of the first payment; not later; manual entries use the original time', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed({}, { firstPayment: '2027-01-01T01:30:00.000Z' }));
  const id = (await submit(db, {})).body.request.requestId;
  const row = (await call(adminForcaCancelRequests, 'or', {})).body.requests[0];
  assert.equal(row.distanceSaleWarning, 'בקשה סמוכה להרשמה – לבדוק ביטול עסקת מכר מרחוק (סעיפים 14ג, 14ה)');
  const d = await call(adminForcaCancelRequests, 'or', { requestId: id });
  assert.deepEqual(d.body.distanceSale.reasons, ['within_14_days']);
  const p = await call(adminForcaSubscriptionStopPreview, 'or', { agreementId: 'ag1', parentRequestId: id });
  assert.match(p.body.request.distanceSaleWarning, /14ג/);

  setNow('2027-03-01T10:00:00.000Z');
  const late = (await submit(db, {})).body.request.requestId;
  assert.equal(stateOf(db, late).distanceSale.warn, false);
  // Phoned in on Jan 10, entered on Mar 1, as א: warned, and no stop by itself.
  const m = await call(adminForcaCancelRequest, 'or', {
    action: 'addManual', parentUid: 'mom', childUid: 'kid1', channel: 'phone', originalAt: '2027-01-10T09:00:00.000Z',
    content: 'ביקשה בטלפון לסיים בסוף החודש', notifyParent: false, choice: 'end_of_paid_month',
  });
  assert.equal(m.status, 200);
  const ms = stateOf(db, m.body.state.requestId);
  assert.deepEqual([ms.choice, ms.choiceSource, ms.distanceSale.warn, ms.autoStop], ['end_of_paid_month', 'admin', true, undefined]);
  assert.equal(agreementOf(db).scheduledStop, undefined);
  assert.equal(receiptOf(db, m.body.state.requestId).content.requestText, 'ביקשה בטלפון לסיים בסוף החודש');
});
