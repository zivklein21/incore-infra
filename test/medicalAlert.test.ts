import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { activeMedicalAlert, adminSetMedicalAlert, parseMedicalAlert } = require('../src/lib/medicalAlert');
const { handler: getCoachTrainees } = require('../src/functions/getCoachTrainees');
const { handler: getGroupWeeklyTaskStatus } = require('../src/functions/getGroupWeeklyTaskStatus');
const { handler: getTrainingHistory } = require('../src/functions/getTrainingHistory');
const { handler: getTraineeOrthopedicForm } = require('../src/functions/getTraineeOrthopedicForm');
const { handler: getMemberDetail } = require('../src/functions/getMemberDetail');
const { resolveSessionDetail } = require('../src/lib/sessionDetail');
const { getCoachAccess, parseCoachPermissions } = require('../src/lib/coachAccess');

const realSend = ddb.send;
afterEach(() => { ddb.send = realSend; });

const ALERT = 'Asthma – inhaler in bag';
const COACH = {
  PK: 'MEMBER#coach1', SK: 'PROFILE',
  identity: { role: 'coach', name: 'Coach', groupIds: ['g1'], coachPermissions: { attendance: 'write', performance: 'read', healthDeclarations: 'read' } },
};
const ADMIN = { PK: 'MEMBER#admin1', SK: 'PROFILE', identity: { role: 'admin', name: 'Or Saraf' } };

// A trainee carrying every kind of medical data. No coach response may contain a SECRET string.
const trainee = (overrides: Record<string, unknown> = {}) => ({
  PK: 'MEMBER#t1', SK: 'PROFILE',
  identity: { name: 'Noa', groupId: 'g1', birthday: '2012-01-01' },
  forms: {
    health_declaration: { submitted_at: '2026-01-01', answers: { q1: 'yes', detail: 'SECRET-health' }, pdf_key: 'SECRET-pdf', doctor_approval_key: 'SECRET-doctor' },
    orthopedic_form: true,
    orthopedic_answers: { knee: 'SECRET-ortho' },
    orthopedic_signature_key: 'SECRET-signature',
    medical_clearance_key: 'SECRET-clearance',
    medical_condition_note: 'SECRET-note',
    registration_answers: { allergies: 'SECRET-registration' },
  },
  medicalAlert: { enabled: true, text: ALERT, updatedAt: '2026-11-01', updatedBy: { uid: 'admin1', name: 'SECRET-author', role: 'admin' } },
  medicalAlertLog: [{ at: '2026-11-01', by: { uid: 'admin1', name: 'SECRET-author', role: 'admin' }, action: 'created', enabled: true, text: 'SECRET-old-text' }],
  ...overrides,
});

function stubTable(profile: Record<string, unknown>) {
  const items: Record<string, unknown> = {
    'incore|MEMBER#admin1|PROFILE': ADMIN,
    'forca|MEMBER#coach1|PROFILE': COACH,
    'forca|MEMBER#t1|PROFILE': profile,
  };
  const updates: any[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: items[`${input.TableName}|${input.Key.PK}|${input.Key.SK}`] };
      case 'ScanCommand': {
        const values = input.ExpressionAttributeValues ?? {};
        if (values[':groupId']) return { Items: [profile] };
        return { Items: values[':sk'] === 'PROFILE' ? [COACH, profile] : [] };
      }
      case 'QueryCommand':
        if (input.ExpressionAttributeValues?.[':pk'] === 'WEEKLYTASK') {
          return { Items: [{ PK: 'WEEKLYTASK#w1', active: true, targetType: 'group', groupId: 'g1', deadline: '2026-12-01', title: 'Task' }] };
        }
        return { Items: [] };
      case 'UpdateCommand':
        updates.push(input);
        return {};
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  }) as typeof ddb.send;
  return updates;
}

const event = (uid: string, extra: Record<string, unknown> = {}) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  ...extra,
}) as any;
const saveEvent = (uid: string, body: unknown) => event(uid, { body: JSON.stringify(body) });

const assertNoMedicalData = (payload: unknown) => {
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('SECRET'), `medical data leaked: ${text}`);
  assert.ok(!text.includes('"medicalFlag":true'), `health-derived flag leaked: ${text}`);
};

async function sessionRoster(uid: string, profile: Record<string, unknown>) {
  stubTable(profile);
  const access = await getCoachAccess(uid);
  ddb.send = (async () => ({ Items: [{ userId: 't1' }] })) as typeof ddb.send;
  const detail = await resolveSessionDetail(
    { PK: 'CLASS#c1', date: '2026-11-07', groupId: 'g1', coachId: 'coach1' },
    {
      trainingTypesById: new Map(), groupNameById: new Map(), equipmentById: new Map(),
      planEquipmentByPlanId: new Map(), profileById: new Map([['t1', profile]]),
    },
    access,
  );
  return detail.roster;
}

test('the alert is only exposed while it is on', () => {
  assert.equal(activeMedicalAlert(trainee()), ALERT);
  assert.equal(activeMedicalAlert(trainee({ medicalAlert: { enabled: false, text: ALERT } })), null);
  assert.equal(activeMedicalAlert(trainee({ medicalAlert: undefined })), null);
  assert.equal(activeMedicalAlert(null), null);
});

test('parseMedicalAlert enforces the limits', () => {
  assert.deepEqual(parseMedicalAlert({ enabled: true, text: `  ${ALERT} ` }), { ok: true, enabled: true, text: ALERT });
  assert.deepEqual(parseMedicalAlert({ enabled: true, text: '   ' }), { ok: false, error: 'text_required' });
  assert.deepEqual(parseMedicalAlert({ enabled: false, text: '' }), { ok: true, enabled: false, text: '' });
  assert.deepEqual(parseMedicalAlert({ enabled: true, text: 'x'.repeat(201) }), { ok: false, error: 'text_too_long' });
  assert.equal(parseMedicalAlert({ enabled: true, text: 'x'.repeat(200) }).ok, true);
  assert.deepEqual(parseMedicalAlert({ enabled: 'yes', text: 'x' }), { ok: false, error: 'invalid_argument' });
});

test('only an admin can set the alert', async () => {
  const updates = stubTable(trainee({ medicalAlert: undefined, medicalAlertLog: undefined }));
  for (const uid of ['coach1', 't1']) {
    const res = await adminSetMedicalAlert(saveEvent(uid, { memberId: 't1', enabled: true, text: ALERT }));
    assert.equal(res.statusCode, 403);
  }
  assert.equal(updates.length, 0);
});

test('creating an alert logs who and when in the same write', async () => {
  const updates = stubTable(trainee({ medicalAlert: undefined, medicalAlertLog: undefined }));
  const res = await adminSetMedicalAlert(saveEvent('admin1', { memberId: 't1', enabled: true, text: ALERT }));
  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  const values = updates[0].ExpressionAttributeValues;
  const [entry] = values[':entry'];
  assert.equal(entry.action, 'created');
  assert.equal(entry.text, ALERT);
  assert.deepEqual(entry.by, { uid: 'admin1', name: 'Or Saraf', role: 'admin' });
  assert.ok(!Number.isNaN(Date.parse(entry.at)));
  assert.equal(values[':alert'].updatedBy.uid, 'admin1');
  assert.match(updates[0].UpdateExpression, /list_append/);
});

test('each kind of change gets its own log action; saving nothing new logs nothing', async () => {
  const on = { enabled: true, text: ALERT, updatedAt: 'x', updatedBy: {} };
  const action = async (medicalAlert: unknown, body: Record<string, unknown>) => {
    const updates = stubTable(trainee({ medicalAlert }));
    await adminSetMedicalAlert(saveEvent('admin1', { memberId: 't1', ...body }));
    return updates[0]?.ExpressionAttributeValues[':entry'][0].action;
  };
  assert.equal(await action(on, { enabled: true, text: 'Diabetes' }), 'changed');
  assert.equal(await action(on, { enabled: false, text: ALERT }), 'turned_off');
  assert.equal(await action({ ...on, enabled: false }, { enabled: true, text: ALERT }), 'turned_on');
  assert.equal(await action(on, { enabled: true, text: ALERT }), undefined);
  assert.equal(await action(undefined, { enabled: false, text: '' }), undefined);
});

test('an unknown member is a 404 and writes nothing', async () => {
  const updates = stubTable(trainee());
  const res = await adminSetMedicalAlert(saveEvent('admin1', { memberId: 'nobody', enabled: true, text: ALERT }));
  assert.equal(res.statusCode, 404);
  assert.equal(updates.length, 0);
});

test('a coach session roster has the alert and no medical data', async () => {
  const [entry] = await sessionRoster('coach1', trainee());
  assert.equal(entry.medicalAlert, ALERT);
  assert.equal(entry.medicalFlag, false);
  assertNoMedicalData(entry);
});

test('a coach session roster shows nothing for an alert that is off', async () => {
  const [entry] = await sessionRoster('coach1', trainee({ medicalAlert: { enabled: false, text: 'SECRET-off' } }));
  assert.equal(entry.medicalAlert, null);
  assertNoMedicalData(entry);
});

test('an admin keeps the health declaration flag on the roster', async () => {
  const [entry] = await sessionRoster('admin1', trainee());
  assert.equal(entry.medicalFlag, true);
  assert.equal(entry.medicalAlert, ALERT);
});

for (const scope of ['all', undefined]) {
  test(`getCoachTrainees (scope ${scope ?? 'default'}) gives a coach no medical data at all`, async () => {
    stubTable(trainee());
    const res = await getCoachTrainees(event('coach1', { queryStringParameters: scope ? { scope } : {} }));
    assert.equal(res.statusCode, 200);
    const { trainees } = JSON.parse(res.body);
    assert.equal(trainees.length, 1);
    assert.ok(!('medicalFlag' in trainees[0]));
    assert.ok(!('medicalAlert' in trainees[0]));
    assertNoMedicalData(trainees);
  });
}

test('getGroupWeeklyTaskStatus gives a coach no medical data at all', async () => {
  stubTable(trainee());
  const res = await getGroupWeeklyTaskStatus(event('coach1', { queryStringParameters: { groupId: 'g1' } }));
  assert.equal(res.statusCode, 200);
  const { tasks } = JSON.parse(res.body);
  assert.ok(!('medicalAlert' in tasks[0].roster[0]));
  assertNoMedicalData(tasks);
});

test('getTrainingHistory leaves the alert out of the roster', async () => {
  stubTable(trainee());
  const realStub = ddb.send;
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const values = cmd.input.ExpressionAttributeValues ?? {};
    if (cmd.constructor.name === 'ScanCommand' && values[':prefix'] === 'CLASS#') {
      return { Items: [{ PK: 'CLASS#c1', date: '2026-11-01', groupId: 'g1', coachId: 'coach1' }] };
    }
    if (cmd.constructor.name === 'QueryCommand' && values[':pk'] === 'CLASS#c1') return { Items: [{ userId: 't1' }] };
    return realStub(cmd);
  }) as typeof ddb.send;
  const res = await getTrainingHistory(event('coach1'));
  assert.equal(res.statusCode, 200);
  const { sessions } = JSON.parse(res.body);
  assert.equal(sessions[0].roster.length, 1);
  assert.ok(!('medicalAlert' in sessions[0].roster[0]));
  assertNoMedicalData(sessions);
});

test('getTraineeOrthopedicForm refuses a coach, even for her own group', async () => {
  stubTable(trainee());
  const res = await getTraineeOrthopedicForm(event('coach1', { queryStringParameters: { memberId: 't1' } }));
  assert.equal(res.statusCode, 403);
  assertNoMedicalData(JSON.parse(res.body));
});

test('getMemberDetail refuses a coach', async () => {
  stubTable(trainee());
  const res = await getMemberDetail(event('coach1', { queryStringParameters: { memberId: 't1', brand: 'forca' } }));
  assert.equal(res.statusCode, 403);
});

test('a stored healthDeclarations permission grants a coach nothing', () => {
  assert.ok(!('healthDeclarations' in parseCoachPermissions({ healthDeclarations: 'read' })));
});
