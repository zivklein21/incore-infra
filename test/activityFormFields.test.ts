import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
// @aws-sdk/client-lambda comes with the Lambda runtime, not node_modules —
// a stand-in so submitFormPart (backgroundJobs.ts) loads; nothing here completes a PDF job for real.
const Module = require('module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === '@aws-sdk/client-lambda' ? request : realResolve.call(this, request, ...rest);
};
const lambdaInvocations: any[] = [];
require.cache['@aws-sdk/client-lambda'] = {
  id: '@aws-sdk/client-lambda', filename: '@aws-sdk/client-lambda', loaded: true,
  exports: {
    LambdaClient: class { send(cmd: any) { lambdaInvocations.push(cmd.input); return Promise.resolve({}); } },
    InvokeCommand: class { constructor(public input: unknown) {} },
  },
} as any;
const { ddb } = require('../src/lib/dynamo');
const {
  activityFieldMap, activityValues, defaultActivityKey, formAnswersFor, liveAdminAnswers, signedOnOlderDetails,
} = require('../src/lib/formTemplates/activityFields');
const { normalizeSections } = require('../src/lib/formTemplates/schema');
const { assignForm } = require('../src/lib/formTemplates/adminAssignFormTemplate');
const { formsForCaller } = require('../src/lib/formTemplates/getMyForms');
const { handler: submitFormPart } = require('../src/lib/formTemplates/submitFormPart');
const { handler: tracking } = require('../src/lib/formTemplates/adminGetFormTracking');
const { handler: updateSession } = require('../src/functions/adminUpdateSessionInstance');

// FORCA-07 style "activity approval" form, with the activity tests from the
// request: prefill from the activity, an edit before signing (families see
// the new details), an edit after signing (the signed copy keeps what was
// signed; the admin is told who signed the older details).

const realSend = ddb.send;
afterEach(() => { ddb.send = realSend; });

// ─── A small in-memory DynamoDB (Get/Put/Update/Query incl. GSI1/Scan) ───────
class World {
  items = new Map<string, any>();
  key = (t: string, pk: string, sk: string) => `${t}|${pk}|${sk}`;
  put(item: any, table = 'forca') { this.items.set(this.key(table, item.PK, item.SK), structuredClone(item)); }
  get(pk: string, sk: string, table = 'forca') { return this.items.get(this.key(table, pk, sk)); }
  inTable(table: string) { return [...this.items.entries()].filter(([k]) => k.startsWith(`${table}|`)).map(([, v]) => v); }

  update(table: string, input: any) {
    const k = this.key(table, input.Key.PK, input.Key.SK);
    const item = this.items.get(k) ?? { ...input.Key };
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const attr = (a: string) => names[a.trim()] ?? a.trim();
    const expr: string = input.UpdateExpression;
    const setPart = /SET (.*?)(?= REMOVE |$)/.exec(expr)?.[1];
    const removePart = /REMOVE (.*)$/.exec(expr)?.[1];
    for (const clause of setPart?.split(', ') ?? []) {
      const [name, value] = clause.split(' = ');
      item[attr(name)] = structuredClone(values[value.trim()]);
    }
    for (const name of removePart?.split(', ') ?? []) delete item[attr(name)];
    this.items.set(k, item);
  }

  install() {
    ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
      const { input } = cmd;
      switch (cmd.constructor.name) {
        case 'GetCommand':
          return { Item: structuredClone(this.get(input.Key.PK, input.Key.SK, input.TableName)) };
        case 'PutCommand':
          this.put(input.Item, input.TableName);
          return {};
        case 'UpdateCommand':
          this.update(input.TableName, input);
          return {};
        case 'QueryCommand': {
          const v = input.ExpressionAttributeValues;
          const prefix = v[':prefix'] ?? '';
          const rows = this.inTable(input.TableName).filter(i => (input.IndexName === 'GSI1'
            ? i.GSI1PK === v[':pk'] && String(i.GSI1SK ?? '').startsWith(prefix)
            : !input.IndexName && i.PK === v[':pk'] && i.SK.startsWith(prefix)));
          return { Items: structuredClone(v[':registered'] ? rows.filter(i => i.status === v[':registered']) : rows) };
        }
        case 'ScanCommand': {
          const v = input.ExpressionAttributeValues ?? {};
          return { Items: structuredClone(this.inTable(input.TableName).filter(i => i.SK === v[':sk'])) };
        }
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    }) as typeof ddb.send;
  }
}

const event = (uid: string, extra: Record<string, unknown>) => ({ requestContext: { authorizer: { jwt: { claims: { sub: uid } } } }, ...extra }) as any;
const post = (uid: string, body: unknown) => event(uid, { body: JSON.stringify(body) });
const body = (res: any) => JSON.parse(res.body);

// The FORCA-07 shape: admin "details box" fields with no activity mapping set
// (built before the mapping existed) — the defaults come from type + label.
const admin = (id: string, type: string, label: string, extra: Record<string, unknown> = {}) => ({ id, type, label, required: true, filledBy: 'admin', ...extra });
const FORCA07_SECTIONS = [
  {
    id: 'details', title: '', details: true, fields: [
      admin('f_name', 'short_text', 'שם הפעילות'),
      admin('f_date', 'date', 'תאריך'),
      admin('f_start', 'time', 'שעת יציאה'),
      admin('f_end', 'time', 'שעת חזרה'),
      admin('f_loc', 'short_text', 'מיקום'),
      admin('f_transport', 'long_text', 'הסעות / אופן ההגעה'),
      admin('f_equipment', 'long_text', 'ציוד נדרש'),
      admin('f_risks', 'long_text', 'סיכונים מיוחדים / הערות בטיחות'),
      admin('f_desc', 'long_text', 'תיאור הפעילות'),
      admin('f_other', 'short_text', 'איש קשר בפעילות'),
    ],
  },
  {
    id: 'sign', title: 'חתימות', fields: [
      { id: 'sig_parent', type: 'signature', label: 'חתימת ההורה', required: true, filledBy: 'parent' },
      { id: 'sig_child', type: 'signature', label: 'חתימת המתאמנת', required: true, filledBy: 'trainee' },
    ],
  },
];

let templateSeq = 0;
function world(sections: unknown[] = FORCA07_SECTIONS) {
  const w = new World();
  const templateId = `forca07-${++templateSeq}`; // getTemplateVersion caches per container — a fresh id per test
  w.put({ PK: 'MEMBER#admin', SK: 'PROFILE', identity: { role: 'admin', firstName: 'Or' }, role: 'admin' }, 'incore');
  w.put({ PK: 'MEMBER#kid', SK: 'PROFILE', identity: { role: 'trainee', first_name: 'Noa', last_name: 'Levi', groupId: 'g1' } });
  w.put({ PK: 'MEMBER#mom', SK: 'PROFILE', identity: { accountType: 'parent_only', first_name: 'Dana', last_name: 'Levi' } });
  w.put({ PK: 'MEMBER#mom', SK: 'FAMILY#kid', childUid: 'kid', parentUid: 'mom', GSI1PK: 'MEMBER#kid', GSI1SK: 'FAMILYOF#mom' });
  w.put({
    PK: 'CLASS#act1', SK: 'METADATA', GSI2PK: 'CLASSDATE#2027-03-10', GSI2SK: 'CLASS#act1', isSpecialActivity: true, groupId: 'g1',
    className: 'טיול שנתי', date: '2027-03-10T06:30:00.000Z', endDate: '2027-03-10T14:00:00.000Z', location: 'עין גדי',
    transport: 'אוטובוס מהמגרש', traineeEquipment: ['מים', 'כובע'], safetyNotes: 'חום — לשתות הרבה', description: 'טיול לנחל דוד',
  });
  w.put({ PK: 'CLASS#act1', SK: 'REG#kid', status: 'REGISTERED', userId: 'kid' });
  const tpl = {
    id: templateId, name: 'אישור השתתפות בפעילות מיוחדת', signers: ['parent', 'trainee'], acknowledgers: [], traineeDevice: 'either',
    sections, settings: { code: 'FORCA-07', kind: 'activity' }, status: 'published', currentVersion: 1, publishedVersion: 1, contentHash: 'h', publishedHash: 'h',
  };
  w.put({ PK: 'APPCONFIG', SK: `FORM_TEMPLATE#${templateId}`, ...tpl });
  w.put({ PK: 'APPCONFIG', SK: `FORM_TEMPLATE_VERSION#${templateId}#0001`, ...tpl, version: 1 });
  w.install();
  return { w, templateId };
}

const parentPhone = { uid: 'mom', childId: 'kid', device: 'parent_phone', brand: 'forca' };
const traineePhone = { uid: 'kid', childId: 'kid', device: 'trainee_phone', brand: 'forca' };
const SIG = (name: string) => ({ paths: ['M0 0 L10 10'], typedName: name });

async function assign(templateId: string) {
  const res = await assignForm({ brand: 'forca', templateId, target: { kind: 'activity', classId: 'act1' }, adminAnswers: { f_other: 'אור 050-0000000' }, notify: false, uid: 'admin' });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.assignmentId as string;
}
const myForm = async (caller = parentPhone) => (await formsForCaller(caller))!.find((f: any) => f.kind === 'activity');

// ─── Pure: mapping + values ─────────────────────────────────────────────────

test('activity values: Israel date/times, end time, what-to-bring list; empty details left out', () => {
  const v = activityValues({
    className: ' טיול ', date: '2027-03-10T06:30:00.000Z', endDate: '2027-03-10T14:00:00.000Z',
    traineeEquipment: ['מים', ' ', 'כובע'], location: '', transport: 'אוטובוס',
  });
  assert.deepEqual(v, {
    'activity.name': 'טיול', 'activity.date': '2027-03-10', 'activity.time': '08:30', 'activity.endTime': '16:00',
    'activity.equipment': 'מים, כובע', 'activity.transport': 'אוטובוס',
  });
});

test('default mapping (FORCA-07, no explicit keys): from type + Hebrew label; unrelated admin fields stay manual', () => {
  const sections = normalizeSections(FORCA07_SECTIONS, 'parent');
  assert.deepEqual(Object.fromEntries(activityFieldMap(sections)), {
    f_name: 'activity.name', f_date: 'activity.date', f_start: 'activity.time', f_end: 'activity.endTime', f_loc: 'activity.location',
    f_transport: 'activity.transport', f_equipment: 'activity.equipment', f_risks: 'activity.safetyNotes', f_desc: 'activity.description',
  });
  assert.equal(defaultActivityKey({ type: 'short_text', label: 'שם הפעילות', filledBy: 'parent' }), null, 'family fields never link');
  assert.equal(defaultActivityKey({ type: 'yes_no', label: 'מיקום', filledBy: 'admin' }), null, 'only text/date/time fields link');
});

test('explicit mapping in the template editor replaces the defaults; keys only stick on admin fields of a fitting type', () => {
  const sections = normalizeSections([{
    id: 's', title: '', fields: [
      admin('a', 'short_text', 'שם הפעילות'),
      admin('b', 'long_text', 'Where we meet', { prefill: 'activity.transport' }),
      { id: 'c', type: 'short_text', label: 'x', required: false, filledBy: 'parent', prefill: 'activity.location' },
    ],
  }], 'parent');
  assert.equal(sections[0].fields[1].prefill, 'activity.transport');
  assert.equal(sections[0].fields[2].prefill, undefined, 'activity.* is for admin fields only');
  assert.deepEqual(Object.fromEntries(activityFieldMap(sections)), { b: 'activity.transport' }, "'a' isn't linked once any field is explicit");
});

test('live answers: linked fields follow the activity; a detail the activity lacks keeps the stored value; frozen copies keep theirs', () => {
  const sections = normalizeSections(FORCA07_SECTIONS, 'parent');
  const stored = { f_name: 'old name', f_transport: 'typed by admin', f_other: 'Or 050' };
  const cls = { className: 'new name', date: '2027-03-10T06:30:00.000Z' };
  const live = liveAdminAnswers(sections, stored, cls);
  assert.equal(live.f_name, 'new name');
  assert.equal(live.f_transport, 'typed by admin');
  assert.equal(live.f_other, 'Or 050');
  assert.equal(live.f_date, '2027-03-10');
  const signedSub = { answers: { ...stored, sig_parent: SIG('Dana') }, signedRoles: ['parent'], ackRoles: [] };
  assert.equal(formAnswersFor({ sections, assignmentAdminAnswers: stored, cls, sub: signedSub }).f_name, 'old name');
  assert.deepEqual(signedOnOlderDetails({ sections, assignmentAdminAnswers: stored, cls, sub: signedSub }).map((c: any) => [c.fieldId, c.signed, c.current]), [
    ['f_name', 'old name', 'new name'], ['f_date', '', '2027-03-10'], ['f_start', '', '08:30'],
  ]);
});

// ─── End to end: assign → see → edit → sign → edit ──────────────────────────

test('prefill: an attached form shows the activity details read-only, without the admin typing them', async () => {
  const { w, templateId } = world();
  const assignmentId = await assign(templateId);
  const stored = w.get('APPCONFIG', `FORM_ASSIGNMENT#${templateId}#${assignmentId}`).adminAnswers;
  assert.equal(stored.f_loc, 'עין גדי', 'snapshot kept as a fallback');

  const f = await myForm();
  assert.equal(f.answers.f_name, 'טיול שנתי');
  assert.equal(f.answers.f_date, '2027-03-10');
  assert.equal(f.answers.f_start, '08:30');
  assert.equal(f.answers.f_end, '16:00');
  assert.equal(f.answers.f_loc, 'עין גדי');
  assert.equal(f.answers.f_transport, 'אוטובוס מהמגרש');
  assert.equal(f.answers.f_equipment, 'מים, כובע');
  assert.equal(f.answers.f_risks, 'חום — לשתות הרבה');
  assert.equal(f.answers.f_desc, 'טיול לנחל דוד');
  assert.ok(f.activityDetailsHash);
  // Read-only: a family can't write an admin field — what they send is ignored.
  const res = await submitFormPart(post('mom', {
    templateId, assignmentId, childId: 'kid', role: 'parent', answers: { f_loc: 'hacked' }, signatures: { sig_parent: SIG('Dana Levi') },
  }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(w.inTable('forca').find(i => i.PK === `FORMSUB#${templateId}`).answers.f_loc, 'עין גדי');
});

test('edit before signing: the family sees the updated details; signing what they saw before the edit is refused', async () => {
  const { w, templateId } = world();
  const assignmentId = await assign(templateId);
  const before = await myForm();

  const edit = await updateSession(post('admin', {
    classId: 'act1', className: 'טיול שנתי — מעודכן', location: 'מצדה', transport: null, traineeEquipment: ['מים'], date: '2027-03-11T06:30:00.000Z',
  }));
  assert.equal(edit.statusCode, 200, edit.body);
  assert.deepEqual(body(edit).signedOnOlderDetails, [], 'nobody signed yet');
  assert.equal(w.get('CLASS#act1', 'METADATA').GSI2PK, 'CLASSDATE#2027-03-11', 'the calendar finds it on its new day');

  const after = await myForm();
  assert.equal(after.answers.f_name, 'טיול שנתי — מעודכן');
  assert.equal(after.answers.f_loc, 'מצדה');
  assert.equal(after.answers.f_date, '2027-03-11');
  assert.equal(after.answers.f_equipment, 'מים');
  assert.equal(after.answers.f_transport, 'אוטובוס מהמגרש', 'a cleared detail keeps the value from assignment time');
  assert.equal(after.activity.date, '2027-03-11T06:30:00.000Z');
  assert.notEqual(after.activityDetailsHash, before.activityDetailsHash);

  const stale = await submitFormPart(post('mom', {
    templateId, assignmentId, childId: 'kid', role: 'parent', signatures: { sig_parent: SIG('Dana Levi') }, activityDetailsHash: before.activityDetailsHash,
  }));
  assert.equal(stale.statusCode, 409);
  assert.equal(body(stale).error, 'activity_details_changed');

  const ok = await submitFormPart(post('mom', {
    templateId, assignmentId, childId: 'kid', role: 'parent', signatures: { sig_parent: SIG('Dana Levi') }, activityDetailsHash: after.activityDetailsHash,
  }));
  assert.equal(ok.statusCode, 200, ok.body);
  const sub = w.inTable('forca').find(i => i.PK === `FORMSUB#${templateId}`);
  assert.equal(sub.answers.f_loc, 'מצדה', 'signed the details shown');
  assert.equal(sub.answers.f_name, 'טיול שנתי — מעודכן');
});

test('edit after signing: the signed copy keeps what was signed; the admin is told who signed the older details', async () => {
  const { w, templateId } = world();
  const assignmentId = await assign(templateId);
  const signed = await submitFormPart(post('mom', {
    templateId, assignmentId, childId: 'kid', role: 'parent', signatures: { sig_parent: SIG('Dana Levi') }, activityDetailsHash: (await myForm()).activityDetailsHash,
  }));
  assert.equal(signed.statusCode, 200, signed.body);

  const edit = await updateSession(post('admin', { classId: 'act1', location: 'מצדה' }));
  assert.equal(edit.statusCode, 200, edit.body);
  const report = body(edit).signedOnOlderDetails;
  assert.equal(report.length, 1);
  assert.equal(report[0].childName, 'Noa Levi');
  assert.deepEqual(report[0].signedBy.map((s: any) => [s.role, s.name]), [['parent', 'Dana Levi']]);
  assert.deepEqual(report[0].changed.map((c: any) => [c.fieldId, c.signed, c.current]), [['f_loc', 'עין גדי', 'מצדה']]);
  assert.equal(report[0].completed, false);

  // Both sides keep seeing the signed version — the trainee signs the same document the parent did.
  assert.equal((await myForm()).answers.f_loc, 'עין גדי');
  assert.equal((await myForm(traineePhone as any)).answers.f_loc, 'עין גדי');
  assert.equal((await myForm(traineePhone as any)).activityDetailsHash, null, 'frozen — no live details to check');
  const child = await submitFormPart(post('kid', { templateId, assignmentId, role: 'trainee', signatures: { sig_child: SIG('Noa Levi') } }));
  assert.equal(child.statusCode, 200, child.body);
  const sub = w.inTable('forca').find(i => i.PK === `FORMSUB#${templateId}`);
  assert.equal(sub.status, 'completed');
  assert.equal(sub.answers.f_loc, 'עין גדי', 'the completed copy (and its PDF, rendered from these answers) keeps the signed details');

  // Assign & track: the row is flagged, the assignment shows what families see now.
  const tr = body(await tracking(event('admin', { queryStringParameters: { templateId, brand: 'forca' } })));
  const a = tr.assignments[0];
  assert.equal(a.currentAdminAnswers.f_loc, 'מצדה');
  assert.equal(a.adminAnswers.f_loc, 'עין גדי', 'existing field unchanged for older apps');
  assert.equal(a.signedOnOlderDetails, 1);
  assert.deepEqual(a.rows[0].activityChanged.map((c: any) => c.fieldId), ['f_loc']);
});

test('training sessions: activity-only details are refused; other forms are untouched', async () => {
  const { w } = world();
  w.put({ PK: 'CLASS#t1', SK: 'METADATA', className: 'Strength', date: '2027-03-10T15:00:00.000Z', GSI2PK: 'CLASSDATE#2027-03-10' });
  const res = await updateSession(post('admin', { classId: 't1', transport: 'bus' }));
  assert.equal(res.statusCode, 400);
  assert.equal(body(res).error, 'not_an_activity');
  const ok = await updateSession(post('admin', { classId: 't1', location: 'Gym' }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(body(ok).signedOnOlderDetails, []);
});
