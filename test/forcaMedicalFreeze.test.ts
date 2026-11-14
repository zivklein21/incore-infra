// Run: npm test
// FORCA medical freeze (section 8): the refund formula, a freeze across two
// months (one refunded at once, one after its charge), the non-retroactive
// default and the reason to start earlier, the 14-day warning, the manual
// fallback, no session bank, the certificate's privacy, and its retention.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';
process.env.ARCHIVE_TABLE_NAME = 'archive';
process.env.BUCKET_NAME = 'uploads';
process.env.HYP_MASOF = 'masof';
process.env.HYP_KEY = 'key';
process.env.HYP_PASSP = 'passp';
// Presigned links are made locally; these never reach AWS.
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.AWS_REGION = 'eu-central-1';

/* eslint-disable @typescript-eslint/no-explicit-any */
const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === '@aws-sdk/client-sesv2') {
    return { SESv2Client: class { async send() { return {}; } }, SendEmailCommand: class { constructor(public input: any) {} } };
  }
  return realLoad.call(this, request, ...rest);
};

const { ddb } = require('../src/lib/dynamo');
const { S3Client } = require('@aws-sdk/client-s3');
const rules = require('../src/lib/forcaMedicalFreeze/rules');
const { certificateDeleteAfter } = require('../src/lib/forcaMedicalFreeze/retention');
const { runDueFreezeRefunds } = require('../src/lib/forcaMedicalFreeze/store');
const { getForcaFreezeUploadUrl } = require('../src/lib/forcaMedicalFreeze/handlers');
const {
  adminForcaCancelRequest, adminForcaCancelRequests, getMyForcaCancelRequests, submitForcaCancelRequest,
} = require('../src/lib/forcaCancelRequests/handlers');
const { handler: getFileUrl } = require('../src/functions/getFileUrl');
const { expireFreezeCertificates } = require('../src/functions/memberRetentionJob');

const realSend = ddb.send;
const realS3Send = S3Client.prototype.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; S3Client.prototype.send = realS3Send; globalThis.fetch = realFetch; mock.timers.reset(); });
const setNow = (iso: string) => mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() });

// ── In-memory table + bucket ────────────────────────────────────────────────

type Obj = { size: number; contentType: string; tags: Record<string, string> };
type Db = { items: Map<string, any>; objects: Map<string, Obj>; hyp: URL[]; hypReply: string };
const pk = (i: any) => i.PK ?? i.memberId;
const sk = (i: any) => i.SK ?? i.recordKey;
const keyOf = (table: string, k: any) => `${table}|${pk(k)}|${sk(k)}`;
const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const condFail = () => { const e = new Error('condition'); (e as any).name = 'ConditionalCheckFailedException'; return e; };

function check(item: any, cond: string | undefined, v: any = {}): boolean {
  if (!cond) return true;
  switch (cond) {
    case 'attribute_not_exists(PK)': return !item;
    case 'version = :v': return !!item && item.version === v[':v'];
    case 'attribute_not_exists(PK) OR version = :v': return !item || item.version === v[':v'];
    case 'attribute_not_exists(refundedTotal) OR refundedTotal = :from': return !!item && (item.refundedTotal === undefined || item.refundedTotal === v[':from']);
    case 'refundedTotal = :from': return !!item && item.refundedTotal === v[':from'];
    default: throw new Error(`test db: unknown condition ${cond}`);
  }
}

function update(item: any, expr: string, names: any = {}, v: any = {}) {
  const lm = /^SET (\w+) = list_append\(if_not_exists\(\w+, :empty\), :f\)$/.exec(expr);
  if (lm) { item[lm[1]] = [...(item[lm[1]] ?? []), ...clone(v[':f'])]; return; }
  for (const clause of expr.replace(/^SET\s+/, '').split(',').map((c) => c.trim())) {
    const [l, r] = clause.split('=').map((x) => x.trim());
    item[names[l] ?? l] = clone(v[r]);
  }
}

function makeDb(seed: Record<string, any>, objects: Record<string, Obj> = {}): Db {
  const db: Db = { items: new Map(Object.entries(clone(seed))), objects: new Map(Object.entries(clone(objects))), hyp: [], hypReply: 'CCode=0&Id=R-1' };
  const all = (t: string) => [...db.items.entries()].filter(([k]) => k.startsWith(`${t}|`)).map(([, x]) => x);
  ddb.send = (async (cmd: any) => {
    const name = cmd.constructor.name; const input = cmd.input; const v = input.ExpressionAttributeValues ?? {};
    if (name === 'GetCommand') return { Item: clone(db.items.get(keyOf(input.TableName, input.Key))) };
    if (name === 'PutCommand') {
      const k = keyOf(input.TableName, input.Item);
      if (!check(db.items.get(k), input.ConditionExpression, v)) throw condFail();
      db.items.set(k, clone(input.Item)); return {};
    }
    if (name === 'DeleteCommand') { db.items.delete(keyOf(input.TableName, input.Key)); return {}; }
    if (name === 'UpdateCommand') {
      const k = keyOf(input.TableName, input.Key);
      const cur = db.items.get(k);
      if (!check(cur, input.ConditionExpression, v)) throw condFail();
      const item = cur ?? { ...input.Key };
      update(item, input.UpdateExpression, input.ExpressionAttributeNames, v);
      db.items.set(k, item); return {};
    }
    if (name === 'TransactWriteCommand') {
      for (const t of input.TransactItems) if (!check(db.items.get(keyOf(t.Put.TableName, t.Put.Item)), t.Put.ConditionExpression, t.Put.ExpressionAttributeValues)) {
        const e = new Error('cancelled'); (e as any).name = 'TransactionCanceledException'; throw e;
      }
      for (const t of input.TransactItems) db.items.set(keyOf(t.Put.TableName, t.Put.Item), clone(t.Put.Item));
      return {};
    }
    if (name === 'QueryCommand') {
      let rows = all(input.TableName);
      const kc: string = input.KeyConditionExpression;
      if (input.IndexName === 'GSI1') {
        rows = rows.filter((r) => r.GSI1PK === v[':pk'] && (!v[':prefix'] || String(r.GSI1SK).startsWith(v[':prefix'])));
        rows.sort((a, b) => (input.ScanIndexForward === false ? b.GSI1SK.localeCompare(a.GSI1SK) : a.GSI1SK.localeCompare(b.GSI1SK)));
      } else if (input.IndexName === 'GSI2') {
        rows = rows.filter((r) => r.GSI2PK === v[':pk'] && (v[':g'] === undefined || r.groupId === v[':g']));
      } else if (/SK <= :upTo/.test(kc)) {
        rows = rows.filter((r) => r.PK === v[':pk'] && r.SK <= v[':upTo']);
      } else if (/begins_with\(SK, :prefix\)/.test(kc)) {
        rows = rows.filter((r) => r.PK === v[':pk'] && String(r.SK).startsWith(v[':prefix'])).sort((a, b) => a.SK.localeCompare(b.SK));
      } else rows = [];
      return { Items: clone(rows) };
    }
    if (name === 'ScanCommand') {
      return { Items: clone(all(input.TableName).filter((r) => String(r.PK).startsWith(v[':prefix']) && r.SK === v[':m'] && (v[':g'] === undefined || r.groupId === v[':g']))) };
    }
    throw new Error(`test db: unexpected ${name}`);
  }) as typeof ddb.send;

  S3Client.prototype.send = async function (cmd: any) {
    const n = cmd.constructor.name; const i = cmd.input;
    const missing = () => { const e = new Error('NoSuchKey'); (e as any).name = 'NoSuchKey'; (e as any).$metadata = { httpStatusCode: 404 }; return e; };
    if (n === 'HeadObjectCommand') { const o = db.objects.get(i.Key); if (!o) throw missing(); return { ContentLength: o.size, ContentType: o.contentType, ETag: '"etag1"' }; }
    if (n === 'CopyObjectCommand') {
      const src = db.objects.get(i.CopySource.slice(i.Bucket.length + 1));
      if (!src) throw missing();
      const tags = Object.fromEntries(String(i.Tagging ?? '').split('&').filter(Boolean).map((p: string) => p.split('=')));
      db.objects.set(i.Key, { ...src, contentType: i.ContentType ?? src.contentType, tags });
      return { CopyObjectResult: { ETag: '"etag2"' } };
    }
    if (n === 'DeleteObjectCommand') { db.objects.delete(i.Key); return {}; }
    if (n === 'GetObjectTaggingCommand') { const o = db.objects.get(i.Key); if (!o) throw missing(); return { TagSet: Object.entries(o.tags).map(([Key, Value]) => ({ Key, Value })) }; }
    if (n === 'ListObjectVersionsCommand') return { Versions: [...db.objects.keys()].filter((k) => k.startsWith(i.Prefix)).map((Key) => ({ Key, VersionId: 'null', Size: 1 })) };
    if (n === 'DeleteObjectsCommand') { for (const o of i.Delete.Objects) db.objects.delete(o.Key); return {}; }
    throw new Error(`test s3: unexpected ${n}`);
  };

  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('exp.host')) return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 't' }] }), text: async () => '' };
    db.hyp.push(new URL(String(url)));
    return { ok: true, status: 200, text: async () => db.hypReply, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return db;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const OR = { PK: 'MEMBER#or', SK: 'PROFILE', role: 'admin', identity: { role: 'admin', first_name: 'Or', last_name: 'Saraf' } };
const ag = {
  PK: 'FORCAAGREEMENT#ag1', SK: 'METADATA', agreementId: 'ag1', userId: 'kid1', payerUid: 'mom', payerName: 'דנה כהן',
  GSI1PK: 'MEMBER#kid1', GSI1SK: 'AGREEMENT#ag1', status: 'active', productName: 'חודשי', groupId: 'g1', groupName: 'בנות 10',
  amountPerCharge: 250, createdAt: '2026-10-01T00:00:00.000Z',
};
function order(id: string, at: string, amount = 250) {
  return {
    [`forca|FORCASUBORDER#${id}|METADATA`]: {
      PK: `FORCASUBORDER#${id}`, SK: 'METADATA', GSI1PK: 'MEMBER#kid1', GSI1SK: `FORCASUBORDER#${at}#${id}`, orderId: id, userId: 'kid1',
      status: 'completed', amount, productName: 'חודשי', groupId: 'g1', hypTransactionId: `T-${id}`, createdAt: at,
    },
  };
}
/** Sessions of group g1 at 17:00 Israel on each day. */
function sessions(days: string[], groupId = 'g1') {
  return Object.fromEntries(days.map((d, i) => [`forca|CLASS#${groupId}-${d}-${i}|METADATA`, {
    PK: `CLASS#${groupId}-${d}-${i}`, SK: 'METADATA', GSI2PK: `CLASSDATE#${d}`, GSI2SK: `CLASS#${d}`, date: `${d}T15:00:00.000Z`, groupId,
  }]));
}
// January 2027 Mondays and Wednesdays: 4, 6, 11, 13, 18, 20, 25, 27.
const JAN = ['2027-01-04', '2027-01-06', '2027-01-11', '2027-01-13', '2027-01-18', '2027-01-20', '2027-01-25', '2027-01-27'];
const TEMPLATE = { 'forca|RECURRINGSESSION#r1|METADATA': { PK: 'RECURRINGSESSION#r1', SK: 'METADATA', groupId: 'g1', dayOfWeek: [1, 3], time: '17:00' } };

function seed(extra: Record<string, any> = {}) {
  return {
    'incore|MEMBER#or|PROFILE': OR,
    'forca|MEMBER#mom|PROFILE': { PK: 'MEMBER#mom', SK: 'PROFILE', identity: { first_name: 'דנה', last_name: 'כהן', email: 'dana@example.com' } },
    'forca|MEMBER#mom|FAMILY#kid1': { PK: 'MEMBER#mom', SK: 'FAMILY#kid1', GSI1PK: 'MEMBER#kid1', GSI1SK: 'FAMILYOF#mom', parentUid: 'mom', childUid: 'kid1' },
    'forca|MEMBER#kid1|PROFILE': { PK: 'MEMBER#kid1', SK: 'PROFILE', identity: { first_name: 'נועה', last_name: 'כהן', groupId: 'g1', birthday: '2015-03-10' } },
    'forca|MEMBER#coach|PROFILE': { PK: 'MEMBER#coach', SK: 'PROFILE', identity: { role: 'coach', first_name: 'מאמנת' } },
    'forca|MEMBER#other|PROFILE': { PK: 'MEMBER#other', SK: 'PROFILE', identity: { first_name: 'אחרת' } },
    'forca|FORCAAGREEMENT#ag1|METADATA': ag,
    ...TEMPLATE,
    ...extra,
  };
}

const ev = (uid: string, body: unknown) => ({ body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { sub: uid } } } } }) as any;
const call = async (fn: any, uid: string, body: unknown) => { const r = await fn(ev(uid, body)); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const stateOf = (db: Db, id: string) => db.items.get(`forca|FORCACANCELREQ#${id}|STATE`);
const receiptOf = (db: Db, id: string) => db.items.get(`forca|FORCACANCELREQ#${id}|RECEIPT`);
const refunds = (db: Db) => [...db.items.values()].filter((i) => String(i.PK).startsWith('FORCAREFUND#'));

/** The parent uploads a certificate and submits the notice. */
async function submitNotice(db: Db, uid = 'mom') {
  const up = await call(getForcaFreezeUploadUrl, uid, { childUid: 'kid1', contentType: 'application/pdf', fileName: 'אישור.pdf' });
  assert.equal(up.status, 200);
  db.objects.set(`forca-medical-freeze/staging/${up.body.uploadId}`, { size: 2048, contentType: 'application/pdf', tags: {} });
  const r = await call(submitForcaCancelRequest, uid, { childUid: 'kid1', type: 'medical_freeze', uploadId: up.body.uploadId, note: 'שבר ביד' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { requestId: r.body.request.requestId as string, uploadId: up.body.uploadId as string, response: r.body };
}

// ── Rules ───────────────────────────────────────────────────────────────────

test('formula: monthly payment x sessions cancelled / sessions scheduled that month', () => {
  assert.equal(rules.refundForMonth(250, 3, 8), 93.75);
  assert.equal(rules.refundForMonth(250, 1, 3), 83.33);
  assert.equal(rules.refundForMonth(250, 8, 8), 250);
  assert.equal(rules.refundForMonth(250, 9, 8), 250, 'never more than the month');
  assert.equal(rules.refundForMonth(250, 0, 8), 0);
  assert.equal(rules.refundForMonth(250, 3, 0), 0);
  assert.equal(rules.refundForMonth(0, 3, 8), 0);
});

test('dates: default start is the day received; earlier only with a reason and a note; under 14 days warns', () => {
  const ok = rules.checkFreezeDates({ from: '2027-01-20', to: '2027-02-10' }, '2027-01-20');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.value.startReason, undefined);

  assert.deepEqual(rules.checkFreezeDates({ from: '2027-01-15', to: '2027-02-10' }, '2027-01-20'), { ok: false, error: 'start_reason_required' });
  assert.deepEqual(rules.checkFreezeDates({ from: '2027-01-15', to: '2027-02-10', startReason: 'vacation', startReasonNote: 'xx' }, '2027-01-20'), { ok: false, error: 'start_reason_required' });
  assert.deepEqual(rules.checkFreezeDates({ from: '2027-01-15', to: '2027-02-10', startReason: 'hospitalization' }, '2027-01-20'), { ok: false, error: 'start_reason_note_required' });
  const early = rules.checkFreezeDates({ from: '2027-01-15', to: '2027-02-10', startReason: 'hospitalization', startReasonNote: 'אושפזה ב-15/1' }, '2027-01-20');
  assert.equal(early.ok, true);
  assert.equal(early.value.startReason, 'hospitalization');
  assert.deepEqual(early.warnings.map((w: any) => w.code), ['retroactive_start']);

  // Later than received: allowed without a reason.
  assert.equal(rules.checkFreezeDates({ from: '2027-01-25', to: '2027-02-10' }, '2027-01-20').ok, true);

  const short = rules.checkFreezeDates({ from: '2027-01-20', to: '2027-01-30' }, '2027-01-20');
  assert.equal(short.ok, true);
  assert.deepEqual(short.warnings.map((w: any) => w.code), ['shorter_than_14_days']);
  assert.equal(rules.checkFreezeDates({ from: '2027-01-20', to: '2027-02-02' }, '2027-01-20').warnings.length, 0, '14 days exactly: fine');
  assert.deepEqual(rules.checkFreezeDates({ from: '2027-02-10', to: '2027-01-20' }, '2027-01-20'), { ok: false, error: 'end_before_start' });
});

test('months, days in each month, and sessions from the recurring schedule', () => {
  assert.deepEqual(rules.monthsInRange('2026-12-20', '2027-02-03'), ['2026-12', '2027-01', '2027-02']);
  assert.deepEqual(rules.freezeDaysIn('2027-02', '2027-01-20', '2027-02-10'), { start: '2027-02-01', end: '2027-02-10' });
  assert.equal(rules.freezeDaysIn('2027-03', '2027-01-20', '2027-02-10'), null);
  // February 2027: Mondays 1, 8, 15, 22 and Wednesdays 3, 10, 17, 24.
  const feb = rules.daysOfMonth('2027-02');
  assert.equal(rules.projectedSessions([{ dayOfWeek: [1, 3] }], feb), 8);
  assert.equal(rules.projectedSessions([{ dayOfWeek: [1, 3] }], feb.filter((d: string) => d <= '2027-02-10')), 4);
});

test('certificate retention: the later of received + 7 years and the 18th birthday + 7 years', () => {
  assert.equal(certificateDeleteAfter('2027-01-20T08:00:00.000Z', '2000-05-01'), '2034-01-20T08:00:00.000Z');
  assert.equal(certificateDeleteAfter('2027-01-20T08:00:00.000Z', '2015-03-10'), '2040-03-10T00:00:00.000Z');
  // No birthday on file: the longest possible (as if born the day it came in).
  assert.equal(certificateDeleteAfter('2027-01-20T08:00:00.000Z', undefined), '2052-01-20T08:00:00.000Z');
});

// ── The notice and the certificate ──────────────────────────────────────────

test('notice: recorded like a request, the certificate moved to a place with no member id, tagged and scheduled for deletion', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed());
  const { requestId, uploadId, response } = await submitNotice(db);
  assert.equal(response.request.type, 'medical_freeze');
  assert.equal(response.request.statusLabel, 'הבקשה התקבלה');
  assert.equal(response.request.hasAttachment, true);

  const rec = receiptOf(db, requestId);
  assert.equal(rec.type, 'medical_freeze');
  assert.equal(rec.receivedAt, '2027-01-20T08:00:00.000Z');
  assert.equal(rec.content.note, 'שבר ביד');
  assert.equal(rec.content.requestText, 'הודעה על הקפאה רפואית של נועה כהן. מצורף אישור רפואי.');
  const key = `forca-medical-freeze/${requestId}/certificate.pdf`;
  assert.deepEqual(rec.attachment, { key, fileName: 'אישור.pdf', contentType: 'application/pdf', size: 2048, etag: 'etag2', deleteAfter: '2040-03-10T00:00:00.000Z' });
  assert.ok(!key.includes('kid1') && !key.includes('mom'));
  assert.deepEqual(db.objects.get(key)!.tags, { retention: 'forca-medical-freeze' });
  assert.equal(db.objects.has(`forca-medical-freeze/staging/${uploadId}`), false, 'staging copy gone: no link can overwrite it');
  assert.ok(db.items.get(`forca|FORCA_CERT_RETENTION|2040-03-10T00:00:00.000Z#${requestId}`));
  // The confirmation names the type and that a certificate came, never the file.
  const msg = db.items.get(`forca|MEMBER#mom|MESSAGE#forcacancelreq_${requestId}`);
  assert.equal(msg.title, 'הודעתך על הקפאה רפואית התקבלה');
  assert.match(msg.body, /20\/01\/2027 10:00/);
  // Listed for Or with its type.
  const list = await call(adminForcaCancelRequests, 'or', {});
  assert.equal(list.body.requests[0].type, 'medical_freeze');
});

test('notice: the certificate is required, and only the uploader can use her upload', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed({ 'forca|MEMBER#other|FAMILY#kid1': { PK: 'MEMBER#other', SK: 'FAMILY#kid1', parentUid: 'other', childUid: 'kid1' } }));
  assert.equal((await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1', type: 'medical_freeze' })).body.error, 'certificate_required');
  assert.equal((await call(getForcaFreezeUploadUrl, 'mom', { childUid: 'kid1', contentType: 'text/html' })).body.error, 'file_type');
  const up = await call(getForcaFreezeUploadUrl, 'mom', { childUid: 'kid1', contentType: 'image/jpeg', fileName: 'a.jpg' });
  assert.equal((await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1', type: 'medical_freeze', uploadId: up.body.uploadId })).body.error, 'upload_missing');
  db.objects.set(`forca-medical-freeze/staging/${up.body.uploadId}`, { size: 11 * 1024 * 1024, contentType: 'image/jpeg', tags: {} });
  assert.equal((await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1', type: 'medical_freeze', uploadId: up.body.uploadId })).body.error, 'file_too_large');
  assert.equal((await call(submitForcaCancelRequest, 'other', { childUid: 'kid1', type: 'medical_freeze', uploadId: up.body.uploadId })).body.error, 'upload_not_found');
  assert.equal((await call(getForcaFreezeUploadUrl, 'coach', { childUid: 'kid1', contentType: 'application/pdf' })).status, 403);
});

test('privacy: only Or gets a link to the certificate; parent, trainee and coach never do', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed());
  const { requestId } = await submitNotice(db);
  const key = receiptOf(db, requestId).attachment.key;
  for (const uid of ['mom', 'kid1', 'coach', 'other']) {
    const r = await call(getFileUrl, uid, { storagePath: key });
    assert.equal(r.status, 403, `${uid} must not read it`);
  }
  assert.equal((await call(getFileUrl, 'or', { storagePath: key })).status, 200);
  const detail = await call(adminForcaCancelRequests, 'or', { requestId });
  assert.match(detail.body.attachmentUrl, /forca-medical-freeze/);
  assert.equal((await call(adminForcaCancelRequests, 'mom', { requestId })).status, 403);
  const parentView = JSON.stringify((await call(getMyForcaCancelRequests, 'mom', {})).body);
  assert.doesNotMatch(parentView, /forca-medical-freeze|X-Amz|certificate\.pdf/);
});

// ── Or decides ──────────────────────────────────────────────────────────────

test('preview: non-retroactive default, per-month sessions, section 8 amounts; a month with no sessions yet is estimated', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed({ ...sessions(JAN), ...order('jan', '2027-01-01T01:30:00.000Z') }));
  const { requestId } = await submitNotice(db);
  const p = await call(adminForcaCancelRequest, 'or', { action: 'freezePreview', requestId, to: '2027-02-10' });
  assert.equal(p.body.receivedDay, '2027-01-20');
  assert.equal(p.body.dates.from, '2027-01-20', 'starts the day received');
  const [jan, feb] = p.body.months;
  assert.deepEqual(
    { s: jan.frozenSessions, t: jan.totalSessions, est: jan.sessionsEstimated, pay: jan.monthlyPayment, payEst: jan.paymentEstimated, amt: jan.formulaAmount, order: jan.chargeOrderId },
    { s: 3, t: 8, est: false, pay: 250, payEst: false, amt: 93.75, order: 'jan' },
  );
  assert.deepEqual(
    { s: feb.frozenSessions, t: feb.totalSessions, est: feb.sessionsEstimated, payEst: feb.paymentEstimated, amt: feb.formulaAmount, order: feb.chargeOrderId },
    { s: 4, t: 8, est: true, payEst: true, amt: 125, order: null },
  );
  // Earlier than received needs the reason.
  const early = await call(adminForcaCancelRequest, 'or', { action: 'freezePreview', requestId, from: '2027-01-15', to: '2027-02-10' });
  assert.equal(early.body.error, 'start_reason_required');
  const short = await call(adminForcaCancelRequest, 'or', { action: 'freezePreview', requestId, to: '2027-01-25' });
  assert.deepEqual(short.body.warnings.map((w: any) => w.code), ['shorter_than_14_days']);
});

test('approve across two months: January refunded now against its charge; February after its charge, from the real sessions', async () => {
  const db = makeDb(seed({ ...sessions(JAN), ...order('jan', '2027-01-01T01:30:00.000Z') }));
  setNow('2027-01-20T08:00:00.000Z');
  const { requestId } = await submitNotice(db);
  mock.timers.setTime(new Date('2027-01-21T09:00:00.000Z').getTime());
  const r = await call(adminForcaCancelRequest, 'or', { action: 'approveFreeze', requestId, from: '2027-01-20', to: '2027-02-10' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // January: refunded at once through the refund function, type medical_freeze, against January's own charge.
  assert.equal(db.hyp.length, 1);
  assert.equal(db.hyp[0].searchParams.get('action'), 'zikoyAPI');
  assert.equal(db.hyp[0].searchParams.get('TransId'), 'T-jan');
  assert.equal(db.hyp[0].searchParams.get('Amount'), '93.75');
  const [janRefund] = refunds(db);
  assert.equal(janRefund.type, 'medical_freeze');
  assert.equal(janRefund.details.parentRequestId, requestId);
  assert.equal(janRefund.details.month, '2027-01');

  let st = stateOf(db, requestId);
  assert.equal(st.status, 'done');
  assert.deepEqual(st.freeze.months.map((m: any) => [m.month, m.status, m.amount]), [['2027-01', 'refunded', 93.75], ['2027-02', 'waiting_for_charge', 125]]);
  assert.ok(db.items.get(`forca|FORCA_FREEZE_REFUND_DUE|2027-02#${requestId}`));
  // "בהקפאה" for coaches: dates only.
  assert.deepEqual(db.items.get('forca|MEMBER#kid1|PROFILE').medicalFreezes, [{ from: '2027-01-20', to: '2027-02-10', requestId }]);
  assert.deepEqual(rules.freezeOn(db.items.get('forca|MEMBER#kid1|PROFILE'), '2027-02-03'), { from: '2027-01-20', to: '2027-02-10' });
  assert.equal(rules.freezeOn(db.items.get('forca|MEMBER#kid1|PROFILE'), '2027-02-11'), null);
  // The parent sees the dates, nothing more.
  const mine = (await call(getMyForcaCancelRequests, 'mom', {})).body.requests[0];
  assert.equal(mine.statusLabel, 'הטיפול הושלם');
  assert.equal(mine.freezeLabel, 'הקפאה רפואית: 20/01/2027–10/02/2027');

  // Before February's charge: nothing happens.
  let run = await runDueFreezeRefunds(new Date('2027-01-31T03:00:00.000Z'));
  assert.equal(run.due, 0);

  // Feb 1: the charge exists, and so do the month's sessions: 7 (Monday the 15th isn't held), 4 of them in the freeze (1, 3, 8, 10).
  const febDays = ['2027-02-01', '2027-02-03', '2027-02-08', '2027-02-10', '2027-02-17', '2027-02-22', '2027-02-24'];
  for (const [k, v] of Object.entries({ ...sessions(febDays), ...order('feb', '2027-02-01T01:30:00.000Z') })) db.items.set(k, v);
  run = await runDueFreezeRefunds(new Date('2027-02-01T03:00:00.000Z'));
  assert.deepEqual(run, { due: 1, refunded: 1, noCharge: 0, failed: 0 });
  assert.equal(db.hyp[1].searchParams.get('TransId'), 'T-feb');
  assert.equal(db.hyp[1].searchParams.get('Amount'), '142.86', '250 x 4 / 7, from the real sessions');
  st = stateOf(db, requestId);
  assert.deepEqual(st.freeze.months[1].status, 'refunded');
  assert.deepEqual({ s: st.freeze.months[1].frozenSessions, t: st.freeze.months[1].totalSessions, est: st.freeze.months[1].sessionsEstimated }, { s: 4, t: 7, est: false });
  assert.equal(db.items.get(`forca|FORCA_FREEZE_REFUND_DUE|2027-02#${requestId}`), undefined);
  assert.deepEqual(
    [...db.items.values()].filter((i) => i.PK === `FORCACANCELREQ#${requestId}` && String(i.SK).startsWith('LOG#')).map((l) => l.action),
    ['received', 'parent_notified', 'freeze_approved', 'freeze_refund', 'freeze_refund'],
  );
  // The monthly charges themselves were never changed.
  assert.equal(db.items.get('forca|FORCASUBORDER#jan|METADATA').amount, 250);
  assert.equal(db.items.get('forca|FORCASUBORDER#feb|METADATA').amount, 250);
});

test('approve: Or\'s adjusted amount is kept; a month never charged has nothing to refund; HYP refusing goes manual', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed({ ...sessions(JAN), ...order('jan', '2027-01-01T01:30:00.000Z') }));
  const { requestId } = await submitNotice(db);
  db.hypReply = 'CCode=33';
  const r = await call(adminForcaCancelRequest, 'or', { action: 'approveFreeze', requestId, from: '2027-01-20', to: '2027-03-10', amounts: { '2027-02': 100 } });
  assert.equal(r.status, 200);
  let st = stateOf(db, requestId);
  assert.equal(st.freeze.months[0].status, 'manual_pending', 'HYP refused: "להחזיר ידנית ב-HYP"');
  assert.equal(refunds(db)[0].status, 'manual_pending');
  assert.deepEqual(st.freeze.months.map((m: any) => [m.month, m.mode]), [['2027-01', 'formula'], ['2027-02', 'fixed'], ['2027-03', 'formula']]);

  db.hypReply = 'CCode=0&Id=R-2';
  for (const [k, v] of Object.entries(order('feb', '2027-02-01T01:30:00.000Z'))) db.items.set(k, v);
  await runDueFreezeRefunds(new Date('2027-02-01T03:00:00.000Z'));
  assert.equal(db.hyp.at(-1)!.searchParams.get('Amount'), '100', 'Or\'s fixed amount');
  // March: no charge all month (e.g. cancelled). On April 1 it's closed: nothing paid, nothing to refund.
  await runDueFreezeRefunds(new Date('2027-03-15T03:00:00.000Z'));
  assert.equal(stateOf(db, requestId).freeze.months[2].status, 'waiting_for_charge');
  const run = await runDueFreezeRefunds(new Date('2027-04-01T03:00:00.000Z'));
  assert.equal(run.noCharge, 1);
  st = stateOf(db, requestId);
  assert.equal(st.freeze.months[2].status, 'no_charge');
});

test('approve: starting earlier needs the reason (kept on the decision); a short freeze is allowed; one decision only; reject', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed({ ...sessions(JAN), ...order('jan', '2027-01-01T01:30:00.000Z') }));
  const { requestId } = await submitNotice(db);
  assert.equal((await call(adminForcaCancelRequest, 'or', { action: 'approveFreeze', requestId, from: '2027-01-13', to: '2027-01-25' })).body.error, 'start_reason_required');
  const ok = await call(adminForcaCancelRequest, 'or', {
    action: 'approveFreeze', requestId, from: '2027-01-13', to: '2027-01-25', startReason: 'accident', startReasonNote: 'נפלה באימון ב-13/1',
  });
  assert.equal(ok.status, 200);
  const f = stateOf(db, requestId).freeze;
  assert.deepEqual({ r: f.startReason, n: f.startReasonNote, from: f.from }, { r: 'accident', n: 'נפלה באימון ב-13/1', from: '2027-01-13' });
  assert.equal(f.warnings.length, 2, '13 days + retroactive start');
  assert.equal(f.months[0].frozenSessions, 4, '13, 18, 20, 25');
  assert.equal((await call(adminForcaCancelRequest, 'or', { action: 'approveFreeze', requestId, from: '2027-01-20', to: '2027-02-10' })).status, 409);
  assert.equal((await call(adminForcaCancelRequest, 'or', { action: 'rejectFreeze', requestId, note: 'כבר הוחלט' })).status, 409);

  const second = await submitNotice(db);
  assert.equal((await call(adminForcaCancelRequest, 'or', { action: 'rejectFreeze', requestId: second.requestId })).body.error, 'note_required');
  const rej = await call(adminForcaCancelRequest, 'or', { action: 'rejectFreeze', requestId: second.requestId, note: 'האישור אינו תקף' });
  assert.equal(rej.status, 200);
  assert.equal(stateOf(db, second.requestId).freeze.decision, 'rejected');
  assert.equal((await call(getMyForcaCancelRequests, 'mom', {})).body.requests.find((x: any) => x.requestId === second.requestId).freezeLabel, null);
});

test('no session bank: a freeze stores dates and refunds, never sessions to use later', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed({ ...sessions(JAN), ...order('jan', '2027-01-01T01:30:00.000Z') }));
  const before = new Set(db.items.keys());
  const { requestId } = await submitNotice(db);
  await call(adminForcaCancelRequest, 'or', { action: 'approveFreeze', requestId, from: '2027-01-20', to: '2027-02-10' });
  const added = [...db.items.keys()].filter((k) => !before.has(k)).map((k) => k.split('|')[1].split('#')[0]);
  assert.deepEqual([...new Set(added)].sort(), ['FORCACANCELREQ', 'FORCAREFUND', 'FORCA_CERT_RETENTION', 'FORCA_FREEZE_REFUND_DUE', 'MEMBER', 'NOTIFICATION'].sort());
  const profile = db.items.get('forca|MEMBER#kid1|PROFILE');
  assert.deepEqual(Object.keys(profile).sort(), ['PK', 'SK', 'identity', 'medicalFreezes'].sort());
});

test('only Or decides', async () => {
  setNow('2027-01-20T08:00:00.000Z');
  const db = makeDb(seed());
  const { requestId } = await submitNotice(db);
  for (const uid of ['mom', 'coach']) {
    assert.equal((await call(adminForcaCancelRequest, uid, { action: 'approveFreeze', requestId, from: '2027-01-20', to: '2027-02-10' })).status, 403);
  }
  // A cancellation request isn't a freeze.
  const cancel = await call(submitForcaCancelRequest, 'mom', { childUid: 'kid1' });
  assert.equal((await call(adminForcaCancelRequest, 'or', { action: 'freezePreview', requestId: cancel.body.request.requestId })).body.error, 'not_a_medical_freeze');
});

// ── Retention ───────────────────────────────────────────────────────────────

test('retention: deleted after its date (rechecking the birthday and the tag), logged like other automatic deletions', async () => {
  const row = (id: string, deleteAfter: string, receivedAt: string) => ({
    [`forca|FORCA_CERT_RETENTION|${deleteAfter}#${id}`]: { PK: 'FORCA_CERT_RETENTION', SK: `${deleteAfter}#${id}`, requestId: id, key: `forca-medical-freeze/${id}/certificate.pdf`, childUid: 'kid1', receivedAt, deleteAfter },
  });
  const tagged = { size: 1, contentType: 'application/pdf', tags: { retention: 'forca-medical-freeze' } };
  const db = makeDb(seed({
    // kid1 born 2015-03-10: due 2040-03-10.
    ...row('due', '2040-03-10T00:00:00.000Z', '2027-01-20T08:00:00.000Z'),
    ...row('untagged', '2040-03-10T00:00:00.000Z', '2027-01-21T08:00:00.000Z'),
    ...row('later', '2050-01-01T00:00:00.000Z', '2027-01-22T08:00:00.000Z'),
  }), {
    'forca-medical-freeze/due/certificate.pdf': tagged,
    'forca-medical-freeze/untagged/certificate.pdf': { ...tagged, tags: {} },
    'forca-medical-freeze/later/certificate.pdf': tagged,
  });
  const before = await expireFreezeCertificates(new Date('2040-03-09T00:00:00.000Z'));
  assert.equal(before.due, 0);
  const res = await expireFreezeCertificates(new Date('2040-04-01T04:00:00.000Z'));
  assert.deepEqual(res, { due: 2, deleted: 1, skipped: 1 });
  assert.equal(db.objects.has('forca-medical-freeze/due/certificate.pdf'), false);
  assert.equal(db.objects.has('forca-medical-freeze/untagged/certificate.pdf'), true, 'untagged: never deleted');
  assert.equal(db.objects.has('forca-medical-freeze/later/certificate.pdf'), true);
  assert.equal(db.items.get('forca|FORCA_CERT_RETENTION|2040-03-10T00:00:00.000Z#due'), undefined);
  const log = [...db.items.values()].filter((i) => i.event === 'auto_deleted');
  assert.deepEqual(log.map((l) => [l.targetMemberId, l.kind, l.detail]), [['kid1', 'medical_freeze_certificate', 'file due']]);

  // A birthday added later moves the date: kept.
  db.items.set('forca|MEMBER#kid1|PROFILE', { ...db.items.get('forca|MEMBER#kid1|PROFILE'), identity: { ...db.items.get('forca|MEMBER#kid1|PROFILE').identity, birthday: '2020-01-01' } });
  db.items.get('forca|FORCA_CERT_RETENTION|2040-03-10T00:00:00.000Z#untagged').receivedAt = '2027-01-21T08:00:00.000Z';
  const again = await expireFreezeCertificates(new Date('2040-04-01T04:00:00.000Z'));
  assert.equal(again.skipped, 1);
  assert.equal(db.objects.has('forca-medical-freeze/untagged/certificate.pdf'), true);
});
