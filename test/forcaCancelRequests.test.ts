// Run: npm test
// FORCA parent cancellation requests. The legal rules, as tests:
//  1. received the moment it's submitted (server time), never waiting for Or;
//  2. requests from other channels are entered with their ORIGINAL time;
//  3. a request cancels and stops nothing (only Or does, elsewhere);
//  4. the parent never sees "not received": every request starts "הבקשה התקבלה".
// Plus: the receipt never changes, every change is in the audit log, the
// section 5.8 suggestion, and charges after receipt flagged for a refund.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The SES client comes from the Lambda runtime, not node_modules: stand in for it.
const sentEmails: any[] = [];
let sesFails = false;
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === '@aws-sdk/client-sesv2') {
    return {
      SESv2Client: class { async send(cmd: any) { if (sesFails) throw new Error('ses down'); sentEmails.push(cmd.input); return {}; } },
      SendEmailCommand: class { input: any; constructor(input: any) { this.input = input; } },
    };
  }
  return realLoad.call(this, request, ...rest);
};

const { ddb } = require('../src/lib/dynamo');
const rules = require('../src/lib/forcaCancelRequests/rules');
const {
  adminForcaCancelRequest, adminForcaCancelRequests, getMyForcaCancelRequests, submitForcaCancelRequest,
} = require('../src/lib/forcaCancelRequests/handlers');
const { adminForcaRefund } = require('../src/lib/forcaRefunds/handlers');
const { handler: parentCancel } = require('../src/functions/cancelForcaSubscription');
const { handler: parentFreeze } = require('../src/functions/setForcaSubscriptionFreeze');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; mock.timers.reset(); sentEmails.length = 0; sesFails = false; });
const setNow = (iso: string) => mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() });

// ── A small in-memory table ─────────────────────────────────────────────────

type Db = { items: Map<string, any>; pushes: any[] };
const keyOf = (table: string, k: any) => `${table}|${k.PK}|${k.SK}`;
const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const conditionFailed = () => { const e = new Error('condition'); (e as any).name = 'ConditionalCheckFailedException'; return e; };

function checkCondition(item: any, cond: string | undefined, values: any = {}): boolean {
  if (!cond) return true;
  switch (cond) {
    case 'attribute_not_exists(PK)': return !item;
    case 'version = :v': return !!item && item.version === values[':v'];
    case 'attribute_not_exists(PK) OR version = :v': return !item || item.version === values[':v'];
    default: throw new Error(`test db: unknown condition ${cond}`);
  }
}

function makeDb(seed: Record<string, any>): Db {
  const db: Db = { items: new Map(Object.entries(clone(seed))), pushes: [] };
  const all = (table: string) => [...db.items.entries()].filter(([k]) => k.startsWith(`${table}|`)).map(([, v]) => v);
  const exec = (name: string, input: any): any => {
    const v = input.ExpressionAttributeValues ?? {};
    if (name === 'GetCommand') return { Item: clone(db.items.get(keyOf(input.TableName, input.Key))) };
    if (name === 'PutCommand') {
      const k = keyOf(input.TableName, input.Item);
      if (!checkCondition(db.items.get(k), input.ConditionExpression, v)) throw conditionFailed();
      db.items.set(k, clone(input.Item)); return {};
    }
    if (name === 'QueryCommand') {
      let rows = all(input.TableName);
      const kc: string = input.KeyConditionExpression;
      if (input.IndexName === 'GSI1') {
        rows = rows.filter((r) => r.GSI1PK === v[':pk'] && (!v[':prefix'] || String(r.GSI1SK).startsWith(v[':prefix'])));
        rows.sort((a, b) => (input.ScanIndexForward === false ? b.GSI1SK.localeCompare(a.GSI1SK) : a.GSI1SK.localeCompare(b.GSI1SK)));
      } else if (input.IndexName === 'GSI2') {
        rows = rows.filter((r) => r.GSI2PK === v[':pk']).sort((a, b) => b.GSI2SK.localeCompare(a.GSI2SK));
      } else if (/begins_with\(SK, :prefix\)/.test(kc)) {
        rows = rows.filter((r) => r.PK === v[':pk'] && String(r.SK).startsWith(v[':prefix'])).sort((a, b) => a.SK.localeCompare(b.SK));
      } else rows = [];
      return { Items: clone(rows) };
    }
    if (name === 'TransactWriteCommand') {
      for (const t of input.TransactItems) {
        const body = t.Put;
        if (!checkCondition(db.items.get(keyOf(body.TableName, body.Item)), body.ConditionExpression, body.ExpressionAttributeValues)) {
          const e = new Error('cancelled'); (e as any).name = 'TransactionCanceledException'; throw e;
        }
      }
      for (const t of input.TransactItems) db.items.set(keyOf(t.Put.TableName, t.Put.Item), clone(t.Put.Item));
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

const OR = { PK: 'MEMBER#or', SK: 'PROFILE', role: 'admin', GSI1PK: 'ROLE#admin', GSI1SK: 'x', identity: { role: 'admin', first_name: 'Or', last_name: 'Saraf' }, expoPushToken: 'ExponentPushToken[or]' };
const AGREEMENT = {
  PK: 'FORCAAGREEMENT#ag1', SK: 'METADATA', agreementId: 'ag1', userId: 'kid1', payerUid: 'mom', payerName: 'דנה כהן',
  GSI1PK: 'MEMBER#kid1', GSI1SK: 'AGREEMENT#ag1', status: 'active', productName: 'חודשי', groupName: 'בנות 10',
  amountPerCharge: 250, createdAt: '2026-10-01T00:00:00.000Z',
};
function seed(extra: Record<string, any> = {}) {
  return {
    'incore|MEMBER#or|PROFILE': OR,
    'forca|MEMBER#mom|PROFILE': { PK: 'MEMBER#mom', SK: 'PROFILE', identity: { first_name: 'דנה', last_name: 'כהן', email: 'dana@example.com', phone: '0501234567' }, expoPushToken: 'ExponentPushToken[mom]' },
    'forca|MEMBER#mom|FAMILY#kid1': { PK: 'MEMBER#mom', SK: 'FAMILY#kid1', GSI1PK: 'MEMBER#kid1', GSI1SK: 'FAMILYOF#mom', parentUid: 'mom', childUid: 'kid1', childName: 'נועה' },
    'forca|MEMBER#kid1|PROFILE': { PK: 'MEMBER#kid1', SK: 'PROFILE', identity: { first_name: 'נועה', last_name: 'כהן', groupId: 'g1' } },
    'forca|MEMBER#stranger|PROFILE': { PK: 'MEMBER#stranger', SK: 'PROFILE', identity: { first_name: 'זרה' } },
    'forca|FORCAAGREEMENT#ag1|METADATA': AGREEMENT,
    ...extra,
  };
}

const ev = (uid: string, body: unknown) => ({ body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { sub: uid } } } } }) as any;
const call = async (fn: any, uid: string, body: unknown) => { const r = await fn(ev(uid, body)); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const receiptOf = (db: Db, id: string) => db.items.get(`forca|FORCACANCELREQ#${id}|RECEIPT`);
const stateOf = (db: Db, id: string) => db.items.get(`forca|FORCACANCELREQ#${id}|STATE`);
const logOf = (db: Db, id: string) => [...db.items.values()].filter((i) => i.PK === `FORCACANCELREQ#${id}` && String(i.SK).startsWith('LOG#')).sort((a, b) => a.SK.localeCompare(b.SK));
const agreementOf = (db: Db) => db.items.get('forca|FORCAAGREEMENT#ag1|METADATA');

// ── Rules ───────────────────────────────────────────────────────────────────

test('section 5.8: active until the end of the month the request was received in (Israel time)', () => {
  assert.deepEqual(rules.suggestedEnd('2027-01-12T08:00:00.000Z'), { receivedDay: '2027-01-12', lastActiveDay: '2027-01-31', stopDay: '2027-02-01' });
  // 00:30 on Feb 1 in Israel is still Jan 31 in UTC: Israel time decides.
  assert.deepEqual(rules.suggestedEnd('2027-01-31T22:30:00.000Z'), { receivedDay: '2027-02-01', lastActiveDay: '2027-02-28', stopDay: '2027-03-01' });
  assert.deepEqual(rules.suggestedEnd('2026-12-20T10:00:00.000Z').stopDay, '2027-01-01');
  assert.equal(rules.suggestedEnd('2028-02-03T10:00:00.000Z').lastActiveDay, '2028-02-29');
  assert.equal(rules.isLaterThan58('2027-02-28', rules.suggestedEnd('2027-01-12T08:00:00.000Z')), true);
  assert.equal(rules.isLaterThan58('2027-01-31', rules.suggestedEnd('2027-01-12T08:00:00.000Z')), false);
});

test('charges after receipt: only later ones, and a month after the suggested end is flagged', () => {
  const charges = [
    { orderId: 'before', amount: 250, createdAt: '2027-01-01T01:30:00.000Z', status: 'completed' },
    { orderId: 'sameMonth', amount: 40, createdAt: '2027-01-20T09:00:00.000Z', status: 'completed' },
    { orderId: 'feb', amount: 250, createdAt: '2027-01-31T23:30:00.000Z', status: 'completed' }, // Feb 1 in Israel
    { orderId: 'failed', amount: 250, createdAt: '2027-02-02T01:30:00.000Z', status: 'failed' },
  ];
  const out = rules.chargesAfterReceipt(charges, '2027-01-12T08:00:00.000Z');
  assert.deepEqual(out.map((c: any) => [c.orderId, c.mayNeedRefund]), [['sameMonth', false], ['feb', true]]);
});

test('parent status labels never say "not received"', () => {
  assert.equal(rules.parentStatusLabel('received', null), 'הבקשה התקבלה');
  assert.equal(rules.parentStatusLabel('in_progress', null), 'בטיפול');
  assert.equal(rules.parentStatusLabel('end_date_set', '2027-01-31'), 'מועד סיום שנקבע: 31/01/2027');
  assert.equal(rules.parentStatusLabel('done', '2027-01-31'), 'הטיפול הושלם');
  for (const s of rules.REQUEST_STATUSES) assert.doesNotMatch(rules.parentStatusLabel(s, null), /לא התקבל|ממתינה לאישור|לא נקלט/);
});

// ── Parent submits ──────────────────────────────────────────────────────────

test('submit: received at the server\'s time, recorded in full, confirmed to the parent, Or notified; nothing cancelled', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  // A time sent by the app is ignored: received is the server's clock.
  const r = await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1', note: 'עוברות דירה', receivedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.statusLabel, 'הבקשה התקבלה');
  assert.equal(r.body.request.receivedAt, '2027-01-12T08:15:00.000Z');
  assert.equal(r.body.request.receivedAtLabel, '12/01/2027 10:15');
  const id = r.body.request.requestId;

  const rec = receiptOf(db, id);
  assert.equal(rec.receivedAt, '2027-01-12T08:15:00.000Z');
  assert.deepEqual(rec.source, { channel: 'app' });
  assert.deepEqual(rec.parent, { uid: 'mom', name: 'דנה כהן', phone: '0501234567', email: 'dana@example.com' });
  assert.deepEqual(rec.child, { uid: 'kid1', name: 'נועה כהן' });
  assert.deepEqual(rec.subscription, { agreementId: 'ag1', productName: 'חודשי', groupName: 'בנות 10', status: 'active', amountPerCharge: 250 });
  assert.equal(rec.content.requestText, 'אני מבקש/ת לבטל את השתתפותה של נועה כהן בפעילות FORCA.');
  assert.equal(rec.content.note, 'עוברות דירה');
  const { PK: _p, SK: _s, contentHash, ...body } = rec;
  assert.equal(contentHash, rules.receiptHash(body));

  // Confirmation: in-app message, push, email, all with the time received.
  const msg = db.items.get(`forca|MEMBER#mom|MESSAGE#forcacancelreq_${id}`);
  assert.match(msg.body, /התקבלה ב-12\/01\/2027 10:15/);
  assert.ok(db.pushes.some((p) => p.to === 'ExponentPushToken[mom]'));
  assert.equal(sentEmails.length, 1);
  assert.deepEqual(sentEmails[0].Destination.ToAddresses, ['dana@example.com']);
  assert.match(sentEmails[0].Content.Simple.Body.Html.Data, /12\/01\/2027 10:15/);
  // Or: push + an admin notification.
  assert.ok(db.pushes.some((p) => p.to === 'ExponentPushToken[or]'));
  assert.ok([...db.items.values()].some((i) => i.type === 'FORCA_CANCEL_REQUEST' && i.requestId === id && i.brand === 'forca'));

  assert.deepEqual(logOf(db, id).map((l) => l.action), ['received', 'parent_notified']);
  assert.equal(stateOf(db, id).parentNotifiedAt, '2027-01-12T08:15:00.000Z');
  // Rule 3: the request itself changes nothing on the subscription.
  assert.deepEqual(agreementOf(db), AGREEMENT);
});

test('submit: still received when every notification fails', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  sesFails = true;
  globalThis.fetch = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
  const r = await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.statusLabel, 'הבקשה התקבלה');
  assert.ok(receiptOf(db, r.body.request.requestId));
  const notified = logOf(db, r.body.request.requestId).find((l) => l.action === 'parent_notified');
  assert.deepEqual(notified.details, { push: false, message: true, email: false });
});

test('submit: only her linked parent or the payer; a child with no subscription can still ask', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed({
    'forca|MEMBER#kid2|PROFILE': { PK: 'MEMBER#kid2', SK: 'PROFILE', identity: { first_name: 'מאיה' } },
    'forca|MEMBER#mom|FAMILY#kid2': { PK: 'MEMBER#mom', SK: 'FAMILY#kid2', GSI1PK: 'MEMBER#kid2', GSI1SK: 'FAMILYOF#mom', parentUid: 'mom', childUid: 'kid2' },
  }));
  assert.equal((await call(submitForcaCancelRequest, 'stranger', { childUid: 'kid1' })).status, 403);
  assert.equal((await call(submitForcaCancelRequest, 'mom', { childUid: '' })).status, 400);
  const r = await call(submitForcaCancelRequest, 'mom', { childUid: 'kid2' });
  assert.equal(r.status, 200);
  assert.equal(receiptOf(db, r.body.request.requestId).subscription, null);
});

test('parent view: her children with the request text, and her requests with the status', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  makeDb(seed());
  await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1' });
  const r = await call(getMyForcaCancelRequests, 'mom', {});
  assert.equal(r.body.children.length, 1);
  assert.equal(r.body.children[0].requestText, 'אני מבקש/ת לבטל את השתתפותה של נועה כהן בפעילות FORCA.');
  assert.equal(r.body.children[0].subscription.productName, 'חודשי');
  assert.equal(r.body.requests.length, 1);
  assert.equal(r.body.requests[0].statusLabel, 'הבקשה התקבלה');
  assert.equal(r.body.requests[0].contentHash, undefined);
  assert.equal((await call(getMyForcaCancelRequests, 'stranger', {})).body.requests.length, 0);
});

// ── Or handles ──────────────────────────────────────────────────────────────

test('Or: statuses, the parent\'s label, lists, unseen count; the receipt never changes; every step logged', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const id = (await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1' })).body.request.requestId;
  const receiptBefore = clone(receiptOf(db, id));

  let list = await call(adminForcaCancelRequests, 'or', {});
  assert.equal(list.body.requests.length, 1);
  assert.equal(list.body.unseenCount, 1);

  mock.timers.tick(60_000);
  await call(adminForcaCancelRequest, 'or', { action: 'markSeen', requestId: id });
  list = await call(adminForcaCancelRequests, 'or', {});
  assert.equal(list.body.unseenCount, 0);
  // Seen by Or changes nothing for the parent.
  assert.equal((await call(getMyForcaCancelRequests, 'mom', {})).body.requests[0].statusLabel, 'הבקשה התקבלה');

  assert.equal((await call(adminForcaCancelRequest, 'or', { action: 'setStatus', requestId: id, status: 'in_progress' })).status, 200);
  assert.equal((await call(getMyForcaCancelRequests, 'mom', {})).body.requests[0].statusLabel, 'בטיפול');
  assert.equal((await call(adminForcaCancelRequest, 'or', { action: 'setStatus', requestId: id, status: 'end_date_set' })).body.error, 'end_date_required');
  await call(adminForcaCancelRequest, 'or', { action: 'setStatus', requestId: id, status: 'end_date_set', endDate: '2027-01-31' });
  assert.equal((await call(getMyForcaCancelRequests, 'mom', {})).body.requests[0].statusLabel, 'מועד סיום שנקבע: 31/01/2027');
  await call(adminForcaCancelRequest, 'or', { action: 'setStatus', requestId: id, status: 'done' });
  assert.equal((await call(getMyForcaCancelRequests, 'mom', {})).body.requests[0].statusLabel, 'הטיפול הושלם');

  assert.equal((await call(adminForcaCancelRequests, 'or', { filter: 'open' })).body.requests.length, 0);
  assert.equal((await call(adminForcaCancelRequests, 'or', { filter: 'handled' })).body.requests.length, 1);
  assert.equal((await call(adminForcaCancelRequests, 'or', { filter: 'all' })).body.requests.length, 1);

  assert.deepEqual(receiptOf(db, id), receiptBefore, 'the receipt is never touched');
  const log = logOf(db, id);
  assert.deepEqual(log.map((l) => l.action), ['received', 'parent_notified', 'seen', 'status', 'status', 'status']);
  assert.deepEqual(log.map((l) => l.version), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(log[4].before, { status: 'in_progress', endDate: null });
  assert.deepEqual(log[4].after, { status: 'end_date_set', endDate: '2027-01-31' });
  assert.deepEqual(log[3].by, { uid: 'or', name: 'Or Saraf' });
  assert.equal(stateOf(db, id).version, 6);
});

test('Or: a request from another channel keeps its original time; the entry time is kept apart', async () => {
  setNow('2027-01-20T12:00:00.000Z');
  const db = makeDb(seed());
  const bad = async (b: any) => (await call(adminForcaCancelRequest, 'or', { action: 'addManual', parentUid: 'mom', childUid: 'kid1', channel: 'whatsapp', originalAt: '2027-01-12T07:40:00.000Z', content: 'הודעת WhatsApp: נועה מפסיקה', ...b })).body.error;
  assert.equal(await bad({ channel: 'app' }), 'invalid_channel');
  assert.equal(await bad({ originalAt: '2027-01-21T12:00:00.000Z' }), 'original_at_in_future');
  assert.equal(await bad({ content: '' }), 'content_required');
  assert.equal(await bad({ parentUid: 'stranger' }), 'not_linked');

  const r = await call(adminForcaCancelRequest, 'or', {
    action: 'addManual', parentUid: 'mom', childUid: 'kid1', channel: 'whatsapp', originalAt: '2027-01-12T07:40:00.000Z', content: 'הודעת WhatsApp: נועה מפסיקה',
  });
  assert.equal(r.status, 200);
  const id = r.body.state.requestId;
  const rec = receiptOf(db, id);
  assert.equal(rec.receivedAt, '2027-01-12T07:40:00.000Z');
  assert.deepEqual(rec.source, { channel: 'whatsapp', enteredBy: { uid: 'or', name: 'Or Saraf' }, enteredAt: '2027-01-20T12:00:00.000Z' });
  assert.equal(rec.content.requestText, 'הודעת WhatsApp: נועה מפסיקה');
  // Section 5.8 counts from the original time, not the day it was entered.
  const detail = await call(adminForcaCancelRequests, 'or', { requestId: id });
  assert.equal(detail.body.suggestion.lastActiveDay, '2027-01-31');
  assert.equal(detail.body.channelLabel, 'WhatsApp');
  // The parent got the confirmation with the original time; Or wasn't paged for her own entry.
  assert.match(db.items.get(`forca|MEMBER#mom|MESSAGE#forcacancelreq_${id}`).body, /12\/01\/2027 09:40/);
  assert.ok(!db.pushes.some((p) => p.to === 'ExponentPushToken[or]'));
  assert.equal(stateOf(db, id).seenAt, '2027-01-20T12:00:00.000Z');
  assert.deepEqual(logOf(db, id).map((l) => l.action), ['entered_manually', 'seen', 'parent_notified']);

  // Without notifying the parent.
  const quiet = await call(adminForcaCancelRequest, 'or', {
    action: 'addManual', parentUid: 'mom', childUid: 'kid1', channel: 'phone', originalAt: '2027-01-15T07:00:00.000Z', content: 'שיחת טלפון', notifyParent: false,
  });
  assert.equal(db.items.get(`forca|MEMBER#mom|MESSAGE#forcacancelreq_${quiet.body.state.requestId}`), undefined);
});

test('Or: request detail flags charges after receipt that may need a refund', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const order = (id: string, at: string) => ({
    [`forca|FORCASUBORDER#${id}|METADATA`]: { PK: `FORCASUBORDER#${id}`, SK: 'METADATA', GSI1PK: 'MEMBER#kid1', GSI1SK: `FORCASUBORDER#${at}#${id}`, orderId: id, userId: 'kid1', status: 'completed', amount: 250, productName: 'חודשי', createdAt: at },
  });
  const db = makeDb(seed({ ...order('jan', '2027-01-01T01:30:00.000Z'), ...order('feb', '2027-02-01T01:30:00.000Z') }));
  const id = (await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1' })).body.request.requestId;
  const d = await call(adminForcaCancelRequests, 'or', { requestId: id });
  assert.deepEqual(d.body.suggestion, { receivedDay: '2027-01-12', lastActiveDay: '2027-01-31', stopDay: '2027-02-01', label: 'מועד מוצע לפי סעיף 5.8' });
  assert.deepEqual(d.body.chargesAfterReceipt.map((c: any) => [c.orderId, c.flag]), [['feb', 'ייתכן שנדרש החזר']]);
  assert.equal(d.body.receipt.PK, undefined);
  assert.deepEqual(d.body.log.map((l: any) => l.action), ['received', 'parent_notified']);
  // Never refunded automatically.
  assert.ok(![...db.items.keys()].some((k) => k.includes('FORCAREFUND#')));
});

test('Or: the texts are versioned, a stale save is refused, and new requests use them', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const s0 = (await call(adminForcaCancelRequests, 'or', {})).body.settings;
  assert.equal(s0.version, 0);
  const save = (basedOn: number, requestText: string) => call(adminForcaCancelRequest, 'or', { action: 'saveSettings', basedOn, requestText, confirmationText: 'קיבלנו את הבקשה ב-{{receivedAt}}.' });
  assert.equal((await save(0, 'בקשה לסיום ההשתתפות של {{childName}}.')).status, 200);
  assert.equal((await save(0, 'גרסה ישנה של הטקסט')).status, 409);
  assert.ok(db.items.get('forca|APPCONFIG|FORCA_CANCEL_REQUEST_SETTINGS#LOG#000001'));
  const id = (await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1' })).body.request.requestId;
  assert.equal(receiptOf(db, id).content.requestText, 'בקשה לסיום ההשתתפות של נועה כהן.');
  assert.equal(db.items.get(`forca|MEMBER#mom|MESSAGE#forcacancelreq_${id}`).body, 'קיבלנו את הבקשה ב-12/01/2027 10:15.');
});

test('admin routes are admin only', async () => {
  makeDb(seed({ 'forca|MEMBER#coach|PROFILE': { PK: 'MEMBER#coach', SK: 'PROFILE', identity: { role: 'coach' } } }));
  for (const uid of ['mom', 'coach']) {
    assert.equal((await call(adminForcaCancelRequests, uid, {})).status, 403);
    assert.equal((await call(adminForcaCancelRequest, uid, { action: 'setStatus', requestId: 'x', status: 'done' })).status, 403);
  }
});

test('a refund given from the request is kept on the refund and written in the request\'s log', async () => {
  setNow('2027-01-12T08:15:00.000Z');
  const db = makeDb(seed());
  const id = (await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1' })).body.request.requestId;
  // No earlier charge: recorded as a manual refund (no HYP call needed for this test).
  const r = await call(adminForcaRefund, 'or', { action: 'create', traineeId: 'kid1', amount: 125, note: 'החזר לפי בקשה', parentRequestId: id });
  assert.equal(r.status, 200);
  const refund = [...db.items.values()].find((i) => String(i.PK).startsWith('FORCAREFUND#'));
  assert.deepEqual(refund.details, { parentRequestId: id });
  const last = logOf(db, id).at(-1);
  assert.equal(last.action, 'refund');
  assert.deepEqual(last.details, { refundId: refund.refundId, amount: 125, status: 'manual_pending', manualReason: 'no_charge' });
  const detail = await call(adminForcaCancelRequests, 'or', { requestId: id });
  assert.deepEqual(detail.body.refunds.map((x: any) => x.refundId), [refund.refundId]);
});

test('rule 3: a parent can no longer cancel or freeze a subscription herself', async () => {
  const db = makeDb(seed());
  for (const fn of [parentCancel, parentFreeze]) {
    const r = await call(fn, 'mom', { agreementId: 'ag1', freeze: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'use_cancellation_request');
  }
  assert.deepEqual(agreementOf(db), AGREEMENT);
});
