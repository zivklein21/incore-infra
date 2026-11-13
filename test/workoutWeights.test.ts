import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { computeLastByExercise, getWorkoutLastWeights, refreshLastWeights } = require('../src/lib/incoreWorkout/lastWeights');
const { selectDueClasses, classEndMs, reminderText, runWorkoutLogReminders } = require('../src/lib/workoutLogReminder');
const { normalizeWorkoutLogReminder } = require('../src/lib/notificationTiming');
const { handler: saveSettings } = require('../src/lib/incoreWorkout/adminSaveWorkoutLogReminderSettings');
const { handler: getJournal } = require('../src/lib/incoreWorkout/getMyWorkoutJournal');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; });

const W = [{ key: 'weight', kind: 'weight', unit: 'kg' }, { key: 'reps', kind: 'reps', unit: 'reps' }];
const ex = (exerciseId: string, weight: number, reps = 8) =>
  ({ exerciseId, exerciseName: exerciseId, muscleGroup: 'chest', metrics: W, sets: [{ weight, reps }] });
const logItem = (id: string, date: string, exercises: any[], updatedAt = `${date}T10:00:00.000Z`) =>
  ({ PK: 'MEMBER#m1', SK: `WORKOUTLOG#${id}`, date, updatedAt, exercises });

const event = (uid: string, extra: Record<string, unknown> = {}) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  ...extra,
}) as any;

// ─── Part A: last working weight ─────────────────────────────────────────────

test('computeLastByExercise takes the newest log per exercise, later edit wins a same-day tie', () => {
  const logs = [
    logItem('a', '2026-11-01', [ex('bench', 40), ex('squat', 80)]),
    logItem('b', '2026-11-03', [ex('bench', 42.5)]),
    logItem('c', '2026-11-03', [ex('bench', 45)], '2026-11-03T18:00:00.000Z'),
  ];
  const last = computeLastByExercise(logs);
  assert.equal(last.get('bench').sets[0].weight, 45);
  assert.equal(last.get('bench').date, '2026-11-03');
  assert.equal(last.get('bench').logId, 'c');
  assert.equal(last.get('squat').sets[0].weight, 80);
  assert.equal(last.has('deadlift'), false, 'never-logged exercise has no entry');
});

test('computeLastByExercise can be limited to some exercises', () => {
  const last = computeLastByExercise([logItem('a', '2026-11-01', [ex('bench', 40), ex('squat', 80)])], new Set(['squat']));
  assert.deepEqual([...last.keys()], ['squat']);
});

// A tiny in-memory table: Query by PK + begins_with, BatchGet, BatchWrite, Put.
function memTable(seed: Record<string, any>[] = [], profiles: Record<string, any> = {}) {
  const rows = new Map<string, any>(seed.map((r) => [`${r.PK}|${r.SK}`, r]));
  for (const [uid, p] of Object.entries(profiles)) rows.set(`MEMBER#${uid}|PROFILE`, { PK: `MEMBER#${uid}`, SK: 'PROFILE', ...p });
  const calls: string[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    calls.push(cmd.constructor.name + (input.IndexName ? `:${input.IndexName}` : ''));
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: rows.get(`${input.Key.PK}|${input.Key.SK}`) };
      case 'QueryCommand': {
        assert.ok(input.KeyConditionExpression, 'must be a keyed Query');
        const pk = input.ExpressionAttributeValues[':pk'];
        const prefix = input.ExpressionAttributeValues[':prefix'] ?? '';
        return { Items: [...rows.values()].filter((r) => r.PK === pk && r.SK.startsWith(prefix)) };
      }
      case 'BatchGetCommand': {
        const keys = input.RequestItems.incore.Keys as any[];
        return { Responses: { incore: keys.map((k) => rows.get(`${k.PK}|${k.SK}`)).filter(Boolean) } };
      }
      case 'BatchWriteCommand':
        for (const r of input.RequestItems.incore) {
          if (r.PutRequest) rows.set(`${r.PutRequest.Item.PK}|${r.PutRequest.Item.SK}`, r.PutRequest.Item);
          if (r.DeleteRequest) rows.delete(`${r.DeleteRequest.Key.PK}|${r.DeleteRequest.Key.SK}`);
        }
        return {};
      case 'PutCommand': {
        const k = `${input.Item.PK}|${input.Item.SK}`;
        if (input.ConditionExpression && rows.has(k)) {
          const err = new Error('exists'); (err as any).name = 'ConditionalCheckFailedException'; throw err;
        }
        rows.set(k, input.Item);
        return {};
      }
      case 'UpdateCommand':
        return {};
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  }) as typeof ddb.send;
  return { rows, calls };
}

test('getWorkoutLastWeights backfills a member once from their own logs, then reads by key', async () => {
  const { rows, calls } = memTable([
    logItem('a', '2026-11-01', [ex('bench', 40), ex('squat', 80)]),
    logItem('b', '2026-11-03', [ex('bench', 42.5)]),
  ]);
  const res = await getWorkoutLastWeights(event('m1', { queryStringParameters: { exerciseIds: 'bench,deadlift' } }));
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.lastWeights.map((w: any) => [w.exerciseId, w.sets[0].weight, w.date]), [['bench', 42.5, '2026-11-03']]);
  assert.ok(rows.has('MEMBER#m1|EXLAST#~built'));
  assert.ok(rows.has('MEMBER#m1|EXLAST#squat'));

  calls.length = 0;
  const again = JSON.parse((await getWorkoutLastWeights(event('m1', { queryStringParameters: { exerciseIds: 'bench' } }))).body);
  assert.equal(again.lastWeights[0].sets[0].weight, 42.5);
  assert.deepEqual(calls, ['BatchGetCommand'], 'second read is a single key lookup');
});

test('getWorkoutLastWeights: another member needs admin or coach', async () => {
  memTable([], { m1: { role: 'member' }, admin1: { role: 'admin' } });
  const denied = await getWorkoutLastWeights(event('m1', { queryStringParameters: { memberId: 'm2' } }));
  assert.equal(denied.statusCode, 403);
  const ok = await getWorkoutLastWeights(event('admin1', { queryStringParameters: { memberId: 'm2' } }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body).lastWeights, []);
});

test('refreshLastWeights moves the pointer back when the newest log loses the exercise', async () => {
  const { rows } = memTable([
    logItem('a', '2026-11-01', [ex('bench', 40)]),
    logItem('b', '2026-11-03', [ex('bench', 45)]),
  ]);
  await refreshLastWeights('m1');
  assert.equal(rows.get('MEMBER#m1|EXLAST#bench').sets[0].weight, 45);
  rows.delete('MEMBER#m1|WORKOUTLOG#b');
  await refreshLastWeights('m1', ['bench']);
  assert.equal(rows.get('MEMBER#m1|EXLAST#bench').sets[0].weight, 40);
  rows.delete('MEMBER#m1|WORKOUTLOG#a');
  await refreshLastWeights('m1', ['bench']);
  assert.equal(rows.has('MEMBER#m1|EXLAST#bench'), false, 'no logs left → pointer removed');
});

test('getMyWorkoutJournal: own journal by default, another member only for admin/coach', async () => {
  memTable([
    logItem('a', '2026-11-01', [ex('bench', 40)]),
  ], { m1: { role: 'member' }, m2: { role: 'member' }, admin1: { role: 'admin' } });
  const own = JSON.parse((await getJournal(event('m1'))).body);
  assert.deepEqual(own.logs.map((l: any) => l.id), ['a']);
  assert.equal((await getJournal(event('m2', { queryStringParameters: { memberId: 'm1' } }))).statusCode, 403);
  const admin = await getJournal(event('admin1', { queryStringParameters: { memberId: 'm1' } }));
  assert.equal(admin.statusCode, 200);
  assert.deepEqual(JSON.parse(admin.body).logs.map((l: any) => l.id), ['a']);
  const adminOwn = JSON.parse((await getJournal(event('admin1'))).body);
  assert.deepEqual(adminOwn.logs, [], "without memberId it's still the caller's own journal");
});

// ─── Part B: logging reminder ───────────────────────────────────────────────

const ON = { enabled: true, delayMinutes: 60 };
const at = (iso: string) => new Date(iso).getTime();

test('selectDueClasses: due from end + delay, for the catch-up window only', () => {
  const cls = { date: '2026-11-11T16:00:00.000Z' }; // ends 17:00 (default 60 min), due 18:00
  assert.equal(selectDueClasses([cls], ON, at('2026-11-11T17:59:00.000Z')).length, 0);
  assert.equal(selectDueClasses([cls], ON, at('2026-11-11T18:00:00.000Z')).length, 1);
  assert.equal(selectDueClasses([cls], ON, at('2026-11-11T19:59:00.000Z')).length, 1);
  assert.equal(selectDueClasses([cls], ON, at('2026-11-11T20:01:00.000Z')).length, 0, 'too old');
  assert.equal(selectDueClasses([cls], { ...ON, enabled: false }, at('2026-11-11T18:00:00.000Z')).length, 0);
  assert.equal(selectDueClasses([{ ...cls, groupId: 'g1' }], ON, at('2026-11-11T18:00:00.000Z')).length, 0, 'FORCA session skipped');
});

test('classEndMs prefers endDate, else start + 60 minutes', () => {
  assert.equal(classEndMs({ date: '2026-11-11T16:00:00.000Z', endDate: '2026-11-11T16:45:00.000Z' }), at('2026-11-11T16:45:00.000Z'));
  assert.equal(classEndMs({ date: '2026-11-11T16:00:00.000Z' }), at('2026-11-11T17:00:00.000Z'));
});

test('normalizeWorkoutLogReminder defaults to off, 60 minutes, and clamps the delay', () => {
  assert.deepEqual(normalizeWorkoutLogReminder(undefined), { enabled: false, delayMinutes: 60 });
  assert.deepEqual(normalizeWorkoutLogReminder({ enabled: true, delayMinutes: -5 }), { enabled: true, delayMinutes: 0 });
  assert.deepEqual(normalizeWorkoutLogReminder({ enabled: true, delayMinutes: 99999 }), { enabled: true, delayMinutes: 720 });
});

test('reminderText is Hebrew by default and names the class', () => {
  assert.match(reminderText('he', 'פילאטיס').body, /פילאטיס/);
  assert.equal(reminderText('en', 'Pilates').title, 'Log your workout');
});

function reminderWorld(extra: Record<string, any>[] = []) {
  const TOKEN = (n: number) => `ExponentPushToken[t${n}]`;
  const world = memTable([
    { PK: 'APPCONFIG', SK: 'NOTIFICATION_TIMING', workoutLogReminder: ON },
    { PK: 'CLASS#c1', SK: 'METADATA', date: '2026-11-11T16:00:00.000Z', className: 'Pilates', GSI2PK: 'CLASSDATE#2026-11-11' },
    { PK: 'CLASS#c1', SK: 'REG#m1', userId: 'm1', status: 'REGISTERED' },
    { PK: 'CLASS#c1', SK: 'REG#m2', userId: 'm2', status: 'REGISTERED' },
    { PK: 'CLASS#c1', SK: 'REG#m3', userId: 'm3', status: 'REGISTERED' },
    { PK: 'MEMBER#m2', SK: 'WORKOUTLOG#cls_c1', date: '2026-11-11', exercises: [] },
    ...extra,
  ], {
    m1: { expoPushToken: TOKEN(1), preferredLanguage: 'en' },
    m2: { expoPushToken: TOKEN(2) },
    m3: { expoPushToken: TOKEN(3) },
  });
  // GSI2 day query + the registration filter, which memTable doesn't model.
  const base = ddb.send;
  ddb.send = (async (cmd: any) => {
    if (cmd.constructor.name === 'QueryCommand' && cmd.input.IndexName === 'GSI2') {
      return { Items: [...world.rows.values()].filter((r) => r.GSI2PK === cmd.input.ExpressionAttributeValues[':pk']) };
    }
    if (cmd.constructor.name === 'QueryCommand' && cmd.input.FilterExpression) {
      const out = await base(cmd);
      return { Items: out.Items.filter((r: any) => r.status === 'REGISTERED') };
    }
    return base(cmd);
  }) as typeof ddb.send;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const batch = JSON.parse(init.body);
    sent.push(...batch);
    return { ok: true, status: 200, json: async () => ({ data: batch.map((_: any, i: number) => ({ status: 'ok', id: `tk${sent.length}_${i}` })) }) };
  }) as any;
  return { ...world, sent };
}

test('runWorkoutLogReminders: only unlogged members, once per class, with the quick-action category', async () => {
  const { sent } = reminderWorld();
  const now = new Date('2026-11-11T18:10:00.000Z');
  const first = await runWorkoutLogReminders(now);
  assert.equal(first.queued, 2);
  assert.equal(first.skippedLogged, 1);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['ExponentPushToken[t1]', 'ExponentPushToken[t3]']);
  const m1 = sent.find((m) => m.to === 'ExponentPushToken[t1]');
  assert.equal(m1.title, 'Log your workout');
  assert.equal(m1.categoryId, 'workout_log_reminder');
  assert.deepEqual(m1.data, { type: 'workout_log_reminder', logClassId: 'c1' });
  assert.equal(m1.data.classId, undefined, 'no classId: store builds would open BookClass');

  const second = await runWorkoutLogReminders(new Date('2026-11-11T18:25:00.000Z'));
  assert.equal(second.queued, 0);
  assert.equal(second.skippedClaimed, 2);
  assert.equal(sent.length, 2, 'at most one reminder per member per class');
});

test('runWorkoutLogReminders does nothing while disabled', async () => {
  const { sent, rows } = reminderWorld();
  rows.set('APPCONFIG|NOTIFICATION_TIMING', { PK: 'APPCONFIG', SK: 'NOTIFICATION_TIMING', workoutLogReminder: { enabled: false, delayMinutes: 60 } });
  const res = await runWorkoutLogReminders(new Date('2026-11-11T18:10:00.000Z'));
  assert.equal(res.result, 'disabled');
  assert.equal(sent.length, 0);
});

test('adminSaveWorkoutLogReminderSettings is admin-only and validates', async () => {
  memTable([], { m1: { role: 'member' }, admin1: { role: 'admin' } });
  assert.equal((await saveSettings(event('m1', { body: JSON.stringify({ enabled: true, delayMinutes: 30 }) }))).statusCode, 403);
  assert.equal((await saveSettings(event('admin1', { body: JSON.stringify({ delayMinutes: 30 }) }))).statusCode, 400);
  const ok = await saveSettings(event('admin1', { body: JSON.stringify({ enabled: true, delayMinutes: 30 }) }));
  assert.deepEqual(JSON.parse(ok.body).workoutLogReminder, { enabled: true, delayMinutes: 30 });
});
