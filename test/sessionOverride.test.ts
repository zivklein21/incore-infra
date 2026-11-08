import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { getSessionPlan, resetSessionOverride, saveSessionOverride } = require('../src/lib/sessionEdit/handlers');
const { handler: saveRecurring } = require('../src/functions/adminSaveRecurringSession');
const { handler: assignPlan } = require('../src/functions/assignSessionWorkoutPlan');
const { handler: saveBlock } = require('../src/functions/adminSaveWorkoutPlanBlock');
const { handler: deleteBlock } = require('../src/functions/adminDeleteWorkoutPlanBlock');
const { handler: toggleEquipment } = require('../src/functions/toggleSessionEquipment');
const { handler: saveTraineeInfo } = require('../src/lib/sessionInfo/saveSessionTraineeInfo');
const { shouldNotifySessionUpdate } = require('../src/lib/sessionInfo/notifySession');
const { matchOverridesToOccurrences } = require('../src/lib/sessionInstance');
const { computeSessionEquipment } = require('../src/lib/sessionDetail');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; });

const DAY = 24 * 60 * 60 * 1000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

// A small in-memory DynamoDB: enough of Get/Put/Delete/Query/Scan/Update/
// TransactWrite to run the real handlers end to end, so these tests assert
// what's actually stored rather than which calls were made.
class World {
  items = new Map<string, any>();
  key = (t: string, pk: string, sk: string) => `${t}|${pk}|${sk}`;
  put(item: any, table = 'forca') { this.items.set(this.key(table, item.PK, item.SK), structuredClone(item)); }
  get(pk: string, sk: string, table = 'forca') { return this.items.get(this.key(table, pk, sk)); }
  partition(pk: string) { return [...this.items.values()].filter((i) => i.PK === pk); }
  snapshot(pk: string) { return JSON.stringify(this.partition(pk).sort((a, b) => a.SK.localeCompare(b.SK))); }

  update(table: string, input: any) {
    const k = this.key(table, input.Key.PK, input.Key.SK);
    const item = this.items.get(k) ?? { ...input.Key };
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const attr = (a: string) => names[a.trim()] ?? a.trim();
    const expr: string = input.UpdateExpression;
    const usedValues = new Set(expr.match(/:\w+/g) ?? []);
    for (const v of Object.keys(values)) if (!usedValues.has(v)) throw new Error(`unused value ${v}`);
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
          return { Item: structuredClone(this.items.get(this.key(input.TableName, input.Key.PK, input.Key.SK))) };
        case 'PutCommand':
          this.put(input.Item, input.TableName);
          return {};
        case 'DeleteCommand': {
          const k = this.key(input.TableName, input.Key.PK, input.Key.SK);
          const old = this.items.get(k);
          this.items.delete(k);
          return { Attributes: old };
        }
        case 'UpdateCommand':
          this.update(input.TableName, input);
          return {};
        case 'TransactWriteCommand':
          for (const t of input.TransactItems) {
            if (t.Put) this.put(t.Put.Item, t.Put.TableName);
            if (t.Update) this.update(t.Update.TableName, t.Update);
          }
          return {};
        case 'QueryCommand': {
          const v = input.ExpressionAttributeValues;
          if (input.IndexName) return { Items: [] };
          const prefix = v[':prefix'] ?? '';
          return { Items: structuredClone(this.partition(v[':pk']).filter((i) => i.SK.startsWith(prefix))) };
        }
        case 'ScanCommand': {
          const v = input.ExpressionAttributeValues ?? {};
          const all = [...this.items.values()];
          if (v[':rsid']) return { Items: structuredClone(all.filter((i) => i.recurringSessionId === v[':rsid'] && i.date >= v[':now'])) };
          if (v[':prefix']) return { Items: structuredClone(all.filter((i) => i.PK.startsWith(v[':prefix']) && (!v[':metadata'] || i.SK === v[':metadata']) && (!v[':profile'] || i.SK === v[':profile']))) };
          return { Items: [] };
        }
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    }) as typeof ddb.send;
  }
}

const event = (uid: string, extra: Record<string, unknown>) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  ...extra,
}) as any;
const post = (uid: string, body: unknown) => event(uid, { body: JSON.stringify(body) });
const body = (res: any) => JSON.parse(res.body);

const COACH_PERMISSIONS = { attendance: 'write', performance: 'read', testsGrading: 'write', equipment: 'write', workoutPlans: 'read', notifications: 'write' };

function world(): World {
  const w = new World();
  w.put({ PK: 'MEMBER#admin', SK: 'PROFILE', identity: { role: 'admin', firstName: 'Or' }, role: 'admin' }, 'incore');
  w.put({ PK: 'MEMBER#coach', SK: 'PROFILE', identity: { role: 'coach', firstName: 'Noa', groupIds: ['g1'], coachPermissions: COACH_PERMISSIONS } });
  w.put({ PK: 'MEMBER#trainee', SK: 'PROFILE', identity: { role: 'trainee', firstName: 'Dana' }, expoPushToken: 'ExponentPushToken[t]' });
  w.put({ PK: 'GROUP#g1', SK: 'METADATA', name: 'Group' });
  w.put({ PK: 'TRAININGTYPE#tt', SK: 'METADATA', name: 'Strength', equipmentRequirements: [{ equipmentId: 'cones', mode: 'custom', customQuantity: 10 }] });
  w.put({ PK: 'EQUIPMENT#cones', SK: 'METADATA', name: 'Cones', quantity: 50, outCount: 0 });
  w.put({ PK: 'EQUIPMENT#bands', SK: 'METADATA', name: 'Bands', quantity: 20, outCount: 0 });
  w.put({ PK: 'EXERCISE#squat', SK: 'METADATA', name: 'Squat', equipment: [] });

  w.put({ PK: 'WORKOUTPLAN#lib', SK: 'METADATA', name: 'Plan A', active: true });
  w.put({ PK: 'WORKOUTPLAN#lib', SK: 'BLOCK#warm', planId: 'lib', label: 'Warm-up', order: 0, mode: 'freeText', freeTextItems: ['Jog', 'Stretch'], coachGuidelines: 'Watch the knees', timeMethod: '10 min' });
  w.put({
    PK: 'WORKOUTPLAN#lib', SK: 'BLOCK#main', planId: 'lib', label: 'Main', order: 1, mode: 'stations', measurable: true,
    stations: [
      { id: 'st1', order: 0, exerciseIds: ['squat'], exerciseNames: ['Squat'], measurable: true },
      { id: 'st2', order: 1, exerciseIds: [], exerciseNames: [], freeTextExercise: 'Plank', notes: '30 sec' },
    ],
  });
  w.put({ PK: 'WORKOUTPLAN#lib', SK: 'BLOCK#close', planId: 'lib', label: 'Debrief', order: 2, mode: 'freeText', locked: true, coachGuidelines: 'Ask one question' });

  w.put({ PK: 'WORKOUTPLAN#other', SK: 'METADATA', name: 'Plan B', active: true });
  w.put({ PK: 'WORKOUTPLAN#other', SK: 'BLOCK#x', planId: 'other', label: 'Only', order: 0, mode: 'freeText', freeTextItems: ['New'] });

  w.put({ PK: 'RECURRINGSESSION#r1', SK: 'METADATA', groupId: 'g1', trainingTypeId: 'tt', dayOfWeek: [new Date(Date.now() + 2 * DAY).getUTCDay()], time: '18:00', active: true, workoutPlanId: 'lib', workoutPlanName: 'Plan A' });
  for (const [id, days] of [['s1', 2], ['s2', 9], ['s3', 16]] as [string, number][]) {
    w.put({
      PK: `CLASS#${id}`, SK: 'METADATA', date: inDays(days), className: 'Strength', groupId: 'g1', coachId: 'coach', coachName: 'Noa',
      trainingTypeId: 'tt', workoutPlanId: 'lib', workoutPlanName: 'Plan A', recurringSessionId: 'r1', allowedMemberIds: ['trainee'],
    });
    w.put({ PK: `CLASS#${id}`, SK: 'REG#trainee', userId: 'trainee', classId: id });
  }
  w.install();
  return w;
}

const pushes = () => {
  const sent: any[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const batch = JSON.parse(init.body);
    sent.push(...batch);
    return { ok: true, json: async () => ({ data: batch.map(() => ({ status: 'ok', id: 'x' })) }) };
  }) as any;
  return sent;
};

// What the edit screen sends when one warm-up line changes and nothing else.
const editedSections = (warm: string[] = ['Jog', 'Stretch', 'Skipping']) => [
  { id: 'warm', timeMethod: '10 min', coachGuidelines: 'Watch the knees', freeTextItems: warm },
  { id: 'main', timeMethod: '', coachGuidelines: '', stations: [{ id: 'st1', text: 'Squat' }, { id: 'st2', text: 'Plank', notes: '30 sec' }] },
  { id: 'close', timeMethod: '', coachGuidelines: 'Ask one question', freeTextItems: [] },
];

const reqRecurring = (extra: Record<string, unknown>) => post('admin', {
  id: 'r1', groupId: 'g1', trainingTypeId: 'tt', dayOfWeek: [new Date(Date.now() + 2 * DAY).getUTCDay()], time: '18:00', workoutPlanId: 'lib', coachId: 'coach', coachName: 'Noa', ...extra,
});

test('editing one session leaves the template and every other session untouched', async () => {
  const w = world();
  pushes();
  const beforeLib = w.snapshot('WORKOUTPLAN#lib');
  const beforeS2 = w.snapshot('CLASS#s2');
  const beforeS3 = w.snapshot('CLASS#s3');
  const beforeTemplate = w.snapshot('RECURRINGSESSION#r1');

  const res = await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).changed, true);

  const s1 = w.get('CLASS#s1', 'METADATA');
  assert.notEqual(s1.workoutPlanId, 'lib');
  assert.equal(s1.planOverride.basePlanId, 'lib');
  assert.equal(s1.planOverride.editedBy.uid, 'coach');
  assert.deepEqual(s1.sessionEditLog.map((e: any) => [e.by.uid, e.action, e.parts]), [['coach', 'edit', ['plan']]]);
  assert.deepEqual(w.get(`WORKOUTPLAN#${s1.workoutPlanId}`, 'BLOCK#warm').freeTextItems, ['Jog', 'Stretch', 'Skipping']);

  assert.equal(w.snapshot('WORKOUTPLAN#lib'), beforeLib);
  assert.equal(w.snapshot('CLASS#s2'), beforeS2);
  assert.equal(w.snapshot('CLASS#s3'), beforeS3);
  assert.equal(w.snapshot('RECURRINGSESSION#r1'), beforeTemplate);
});

test('a save that changes nothing creates no override and sends no push', async () => {
  const w = world();
  const sent = pushes();
  const res = await saveSessionOverride(post('coach', {
    classId: 's1', sections: editedSections(['Jog', 'Stretch']), equipment: [{ equipmentId: 'cones', quantity: 10 }],
  }));
  assert.equal(body(res).changed, false);
  assert.equal(w.get('CLASS#s1', 'METADATA').workoutPlanId, 'lib');
  assert.equal(w.get('CLASS#s1', 'METADATA').planOverride, undefined);
  assert.equal(w.get('CLASS#s1', 'METADATA').equipmentOverride, undefined);
  assert.equal(sent.length, 0);
});

test('structure can\'t change: added, removed or reordered sections are refused', async () => {
  const w = world();
  pushes();
  const [warm, main, close] = editedSections();
  for (const sections of [[main, warm, close], [warm, main], [warm, main, close, { id: 'new', freeTextItems: ['x'] }]]) {
    const res = await saveSessionOverride(post('coach', { classId: 's1', sections }));
    assert.equal(res.statusCode, 409);
    assert.equal(body(res).error, 'structure_changed');
  }
  assert.equal(w.get('CLASS#s1', 'METADATA').workoutPlanId, 'lib');
});

test('label, mode, order and locked can\'t be smuggled in through a save', async () => {
  const w = world();
  pushes();
  const sections = editedSections().map((s) => ({ ...s, label: 'Hacked', mode: 'stations', order: 9, locked: false }));
  await saveSessionOverride(post('coach', { classId: 's1', sections }));
  const copy = w.get('CLASS#s1', 'METADATA').workoutPlanId;
  const close = w.get(`WORKOUTPLAN#${copy}`, 'BLOCK#close');
  assert.equal(close.label, 'Debrief');
  assert.equal(close.mode, 'freeText');
  assert.equal(close.order, 2);
  assert.equal(close.locked, true);
});

test('rows: delete, add, and a rewritten catalog line loses its link but an untouched one keeps it', async () => {
  const w = world();
  pushes();
  const [warm, , close] = editedSections(['Jog']);
  const main = { id: 'main', timeMethod: '', coachGuidelines: '', stations: [{ id: 'st1', text: 'Squat' }, { id: 'st2', text: '' , notes: '' }, { text: 'Lunges' }] };
  await saveSessionOverride(post('coach', { classId: 's1', sections: [warm, main, close] }));
  const copy = w.get('CLASS#s1', 'METADATA').workoutPlanId;
  const block = w.get(`WORKOUTPLAN#${copy}`, 'BLOCK#main');
  assert.deepEqual(block.stations.map((s: any) => s.order), [0, 1]);
  assert.equal(block.stations[0].id, 'st1');
  assert.deepEqual(block.stations[0].exerciseIds, ['squat']);
  assert.equal(block.stations[0].measurable, true);
  assert.equal(block.measurable, true);
  assert.equal(block.stations[1].freeTextExercise, 'Lunges');

  const rewritten = { ...main, stations: [{ id: 'st1', text: 'Goblet squat' }] };
  await saveSessionOverride(post('coach', { classId: 's1', sections: [warm, rewritten, close] }));
  const after = w.get(`WORKOUTPLAN#${copy}`, 'BLOCK#main');
  assert.deepEqual(after.stations[0].exerciseIds, []);
  assert.equal(after.stations[0].freeTextExercise, 'Goblet squat');
  assert.equal(after.stations[0].measurable, undefined);
  assert.equal(after.measurable, undefined);
});

test('a catalog name with stray whitespace keeps its link through an unrelated save', async () => {
  const w = world();
  pushes();
  const main = w.get('WORKOUTPLAN#lib', 'BLOCK#main');
  main.stations[0].exerciseNames = ['Squat '];
  w.put(main);
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  const copy = w.get('CLASS#s1', 'METADATA').workoutPlanId;
  assert.deepEqual(w.get(`WORKOUTPLAN#${copy}`, 'BLOCK#main').stations[0].exerciseIds, ['squat']);
});

test('equipment: add, remove, change quantity and reorder apply to that session only', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', equipment: [{ equipmentId: 'bands', quantity: 4 }, { equipmentId: 'cones', quantity: 6 }] }));
  assert.deepEqual(body(await getSessionPlan(event('coach', { queryStringParameters: { classId: 's1' } }))).equipment,
    [{ id: 'bands', name: 'Bands', quantity: 4 }, { id: 'cones', name: 'Cones', quantity: 6 }]);
  assert.deepEqual(body(await getSessionPlan(event('coach', { queryStringParameters: { classId: 's2' } }))).equipment,
    [{ id: 'cones', name: 'Cones', quantity: 10 }]);

  await saveSessionOverride(post('coach', { classId: 's1', equipment: [] }));
  assert.deepEqual(w.get('CLASS#s1', 'METADATA').equipmentOverride.items, []);
  assert.deepEqual(body(await getSessionPlan(event('coach', { queryStringParameters: { classId: 's1' } }))).equipment, []);
});

test('checked-out gear can\'t be removed, and checking out uses the override quantity', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', equipment: [{ equipmentId: 'cones', quantity: 6 }] }));
  await toggleEquipment(post('coach', { classId: 's1', equipmentId: 'cones', taken: true }));
  assert.deepEqual(w.get('CLASS#s1', 'METADATA').equipmentTaken, [{ equipmentId: 'cones', quantity: 6 }]);
  assert.equal(w.get('EQUIPMENT#cones', 'METADATA').outCount, 6);

  const res = await saveSessionOverride(post('coach', { classId: 's1', equipment: [{ equipmentId: 'bands', quantity: 1 }] }));
  assert.equal(res.statusCode, 409);
  assert.equal(body(res).error, 'equipment_still_taken');
});

test('reset deletes the override and the private copy and goes back to the template', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections(), equipment: [{ equipmentId: 'bands', quantity: 2 }] }));
  const copy = w.get('CLASS#s1', 'METADATA').workoutPlanId;

  const res = await resetSessionOverride(post('coach', { classId: 's1' }));
  assert.equal(res.statusCode, 200);
  const s1 = w.get('CLASS#s1', 'METADATA');
  assert.equal(s1.workoutPlanId, 'lib');
  assert.equal(s1.planOverride, undefined);
  assert.equal(s1.equipmentOverride, undefined);
  assert.deepEqual(s1.sessionEditLog.map((e: any) => e.action), ['edit', 'reset']);
  assert.equal(w.partition(`WORKOUTPLAN#${copy}`).length, 0);
  assert.ok(w.get('WORKOUTPLAN#lib', 'METADATA'));
  assert.deepEqual(body(await getSessionPlan(event('trainee', { queryStringParameters: { classId: 's1' } }))).sections[0].freeTextItems, ['Jog', 'Stretch']);
});

test('reset is refused rather than losing the edit when the original plan was deleted', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  for (const item of w.partition('WORKOUTPLAN#lib')) w.items.delete(w.key('forca', item.PK, item.SK));
  const res = await resetSessionOverride(post('coach', { classId: 's1' }));
  assert.equal(res.statusCode, 409);
  assert.equal(body(res).error, 'base_plan_missing');
  assert.ok(w.get('CLASS#s1', 'METADATA').planOverride);
});

test('editing the library plan changes sessions without an override, not the edited one', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  await saveBlock(post('admin', { id: 'warm', planId: 'lib', label: 'Warm-up', mode: 'freeText', freeTextItems: ['Template changed'] }));

  const view = async (classId: string) => body(await getSessionPlan(event('trainee', { queryStringParameters: { classId } }))).sections[0].freeTextItems;
  assert.deepEqual(await view('s1'), ['Jog', 'Stretch', 'Skipping']);
  assert.deepEqual(await view('s2'), ['Template changed']);
});

test('changing the recurring template\'s plan skips overridden sessions and moves their reset target', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections(), equipment: [{ equipmentId: 'bands', quantity: 2 }] }));
  const copy = w.get('CLASS#s1', 'METADATA').workoutPlanId;

  const res = await saveRecurring(reqRecurring({ workoutPlanId: 'other', location: 'Field 2' }));
  assert.equal(res.statusCode, 200);

  const s1 = w.get('CLASS#s1', 'METADATA');
  assert.equal(s1.workoutPlanId, copy);
  assert.equal(s1.workoutPlanName, 'Plan A');
  assert.equal(s1.location, 'Field 2');
  assert.deepEqual(s1.equipmentOverride.items, [{ equipmentId: 'bands', quantity: 2 }]);
  assert.equal(w.get('CLASS#s2', 'METADATA').workoutPlanId, 'other');

  await resetSessionOverride(post('coach', { classId: 's1' }));
  assert.equal(w.get('CLASS#s1', 'METADATA').workoutPlanId, 'other');
  assert.equal(w.get('CLASS#s1', 'METADATA').workoutPlanName, 'Plan B');
});

test('a template pattern change regenerates sessions and the override moves to its replacement', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections(), equipment: [{ equipmentId: 'bands', quantity: 2 }] }));
  const copy = w.get('CLASS#s1', 'METADATA').workoutPlanId;

  const nextDay = new Date(Date.now() + 3 * DAY).getUTCDay();
  const res = await saveRecurring(reqRecurring({ dayOfWeek: [nextDay] }));
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).overridesLost, 0);

  assert.equal(w.get('CLASS#s1', 'METADATA'), undefined);
  const carried = [...w.items.values()].filter((i) => i.SK === 'METADATA' && i.planOverride);
  assert.equal(carried.length, 1);
  assert.equal(carried[0].workoutPlanId, copy);
  assert.deepEqual(carried[0].equipmentOverride.items, [{ equipmentId: 'bands', quantity: 2 }]);
  assert.equal(w.get(`WORKOUTPLAN#${copy}`, 'METADATA').sessionClassId, carried[0].PK.replace('CLASS#', ''));
  assert.deepEqual(w.get(`WORKOUTPLAN#${copy}`, 'BLOCK#warm').freeTextItems, ['Jog', 'Stretch', 'Skipping']);
});

test('matchOverridesToOccurrences: nearest within the week, each taken once, the rest lost', () => {
  const d = (n: number) => new Date(Date.UTC(2026, 10, n, 16)).toISOString();
  const { pairs, lost } = matchOverridesToOccurrences(
    [{ date: d(10) }, { date: d(11) }, { date: d(24) }],
    [{ classId: 'a', date: d(12) }, { classId: 'b', date: d(19) }],
  );
  assert.deepEqual(pairs.map((p: any) => [p.from.date, p.toClassId]), [[d(10), 'a']]);
  assert.deepEqual(lost.map((l: any) => l.date), [d(11), d(24)]);
});

test('assigning a different plan replaces the override and cleans up its copy', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  const copy = w.get('CLASS#s1', 'METADATA').workoutPlanId;
  await assignPlan(post('admin', { classId: 's1', workoutPlanId: 'other' }));
  assert.equal(w.get('CLASS#s1', 'METADATA').planOverride, undefined);
  assert.equal(w.partition(`WORKOUTPLAN#${copy}`).length, 0);
});

test('the plan builder can\'t change a session copy\'s structure', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  const planId = w.get('CLASS#s1', 'METADATA').workoutPlanId;
  assert.equal((await saveBlock(post('admin', { planId, label: 'New', mode: 'freeText' }))).statusCode, 403);
  assert.equal((await deleteBlock(post('admin', { planId, id: 'warm' }))).statusCode, 403);
});

test('permissions: only admin or the session\'s own coach, and closed is admin-only', async () => {
  const w = world();
  pushes();
  w.put({ PK: 'MEMBER#coach2', SK: 'PROFILE', identity: { role: 'coach', firstName: 'Other', groupIds: ['g1'], coachPermissions: COACH_PERMISSIONS } });
  const req = { classId: 's1', sections: editedSections() };

  assert.equal((await saveSessionOverride(post('trainee', req))).statusCode, 403);
  assert.equal((await saveSessionOverride(post('coach2', req))).statusCode, 403);
  assert.equal((await resetSessionOverride(post('trainee', { classId: 's1' }))).statusCode, 403);

  const closed = w.get('CLASS#s2', 'METADATA');
  w.put({ ...closed, closedAt: inDays(-1) });
  assert.equal((await saveSessionOverride(post('coach', { ...req, classId: 's2' }))).statusCode, 403);
  assert.equal((await saveSessionOverride(post('admin', { ...req, classId: 's2' }))).statusCode, 200);
});

test('a coach with no plan access can\'t edit the plan or wipe its gear from the pack list', async () => {
  const w = world();
  pushes();
  const profile = w.get('MEMBER#coach', 'PROFILE');
  profile.identity.coachPermissions = { ...COACH_PERMISSIONS, workoutPlans: 'none' };
  w.put(profile);
  assert.equal((await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }))).statusCode, 403);
  assert.equal((await saveSessionOverride(post('coach', { classId: 's1', equipment: [] }))).statusCode, 403);
});

test('trainees get the effective plan with no coach-only content', async () => {
  const w = world();
  pushes();
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  const res = await getSessionPlan(event('trainee', { queryStringParameters: { classId: 's1' } }));
  assert.equal(res.statusCode, 200);
  const raw = res.body as string;
  assert.ok(!raw.includes('Watch the knees'));
  assert.ok(!raw.includes('Ask one question'));
  assert.ok(!raw.includes('editLog'));
  const view = JSON.parse(raw);
  assert.equal(view.editedForSession, true);
  assert.deepEqual(view.sections.map((s: any) => s.label), ['Warm-up', 'Main']);
  assert.deepEqual(view.sections[0].freeTextItems, ['Jog', 'Stretch', 'Skipping']);
  assert.equal(view.sections[1].stations[1].notes, '30 sec');

  const staff = body(await getSessionPlan(event('coach', { queryStringParameters: { classId: 's1' } })));
  assert.equal(staff.sections[0].coachGuidelines, 'Watch the knees');
  assert.equal(staff.editLog.length, 1);
});

test('a stranger, or a parent of someone else\'s child, can\'t read a session', async () => {
  const w = world();
  w.put({ PK: 'MEMBER#stranger', SK: 'PROFILE', identity: { role: 'trainee', firstName: 'X' } });
  assert.equal((await getSessionPlan(event('stranger', { queryStringParameters: { classId: 's1' } }))).statusCode, 403);
  assert.equal((await getSessionPlan(event('stranger', { queryStringParameters: { classId: 's1', childUid: 'trainee' } }))).statusCode, 403);

  w.put({ PK: 'MEMBER#parent', SK: 'PROFILE', identity: { role: 'parent', firstName: 'P' } });
  w.put({ PK: 'MEMBER#parent', SK: 'FAMILY#trainee', parentUid: 'parent', childUid: 'trainee' });
  assert.equal((await getSessionPlan(event('parent', { queryStringParameters: { classId: 's1', childUid: 'trainee' } }))).statusCode, 200);
});

test('one push per save, with the requested text, only when trainees already know', async () => {
  const w = world();
  const sent = pushes();

  // s1 is two days out: on her Home already. One save of both parts, one push.
  const res = await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections(), equipment: [{ equipmentId: 'bands', quantity: 2 }] }));
  assert.equal(body(res).notified, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /^עודכן מערך\/ציוד לאימון .+ \d\d:\d\d$/);
  assert.equal(sent[0].data.type, 'session_updated');
  assert.equal(sent[0].data.sessionId, 's1');
  assert.equal(sent[0].data.classId, undefined);

  // s3 is 16 days out and nothing has been sent about it: no push.
  await saveSessionOverride(post('coach', { classId: 's3', sections: editedSections() }));
  assert.equal(sent.length, 1);

  // Same distance, but a note push already went out: this one does push.
  await saveTraineeInfo(post('coach', { classId: 's2', traineeNote: 'Bring water' }));
  assert.equal(sent.length, 2);
  assert.ok(w.get('CLASS#s2', 'METADATA').traineesNotifiedAt);
  await saveSessionOverride(post('coach', { classId: 's2', sections: editedSections() }));
  assert.equal(sent.length, 3);
});

test('a started session never pushes', async () => {
  const w = world();
  const sent = pushes();
  w.put({ ...w.get('CLASS#s1', 'METADATA'), date: inDays(-0.01), traineesNotifiedAt: inDays(-1) });
  await saveSessionOverride(post('coach', { classId: 's1', sections: editedSections() }));
  assert.equal(sent.length, 0);
});

test('trainee gear list: an edit pushes once, a note in the same save doesn\'t double it', async () => {
  world();
  const sent = pushes();
  await saveTraineeInfo(post('coach', { classId: 's1', traineeEquipment: ['Water'] }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /^עודכן מערך\/ציוד לאימון /);
  await saveTraineeInfo(post('coach', { classId: 's1', traineeEquipment: ['Water'] }));
  assert.equal(sent.length, 1);
  await saveTraineeInfo(post('coach', { classId: 's1', traineeNote: 'Early start', traineeEquipment: ['Water', 'Towel'] }));
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /Early start/);
});

test('shouldNotifySessionUpdate boundaries', () => {
  const now = Date.now();
  const at = (d: number) => new Date(now + d * DAY).toISOString();
  assert.equal(shouldNotifySessionUpdate({ date: at(6.9) }, now), true);
  assert.equal(shouldNotifySessionUpdate({ date: at(7.1) }, now), false);
  assert.equal(shouldNotifySessionUpdate({ date: at(30), traineesNotifiedAt: at(-1) }, now), true);
  assert.equal(shouldNotifySessionUpdate({ date: at(-0.1), traineesNotifiedAt: at(-1) }, now), false);
});

test('computeSessionEquipment: an empty override means nothing needed, not "use the template"', () => {
  const inputs = {
    trainingType: { equipmentRequirements: [{ equipmentId: 'a', mode: 'custom', customQuantity: 3 }] },
    planQuantities: new Map([['b', 2]]),
    equipmentById: new Map([['a', { name: 'A', availableQuantity: 9 }], ['b', { name: 'B', availableQuantity: 9 }]]),
    rosterCount: 4,
  };
  assert.deepEqual(computeSessionEquipment({}, inputs).map((e: any) => [e.id, e.neededQuantity]), [['a', 3], ['b', 2]]);
  assert.deepEqual(computeSessionEquipment({ manualEquipment: [{ equipmentId: 'a', quantity: 7 }] }, inputs).map((e: any) => e.neededQuantity), [7, 2]);
  assert.deepEqual(computeSessionEquipment({ equipmentOverride: { items: [] } }, inputs), []);
  assert.deepEqual(computeSessionEquipment({ equipmentOverride: { items: [{ equipmentId: 'gone', quantity: 1 }, { equipmentId: 'b', quantity: 1 }] } }, inputs).map((e: any) => e.id), ['b']);
});

