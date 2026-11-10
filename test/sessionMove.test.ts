import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { israelDateStr } = require('../src/lib/entities');
const { planDayIndexRepairs } = require('../src/lib/sessionMove');
const { handler: adminUpdateSessionInstance } = require('../src/functions/adminUpdateSessionInstance');
const { handler: updateClass } = require('../src/functions/updateClass');
const { handler: saveClassSeries } = require('../src/functions/saveClassSeries');
const { handler: adminListActivities } = require('../src/lib/formTemplates/adminListActivities');

// Moving a session to another day, in each brand: afterwards it's found ONLY
// on its new day by every by-day reader (coach calendar / schedule /
// reminders / activity picker all query GSI2 CLASSDATE#<day>), and its
// registrations, counts and form assignments stay with it.

const realSend = ddb.send;
afterEach(() => { ddb.send = realSend; });

class World {
  items = new Map<string, any>();
  key = (t: string, pk: string, sk: string) => `${t}|${pk}|${sk}`;
  put(item: any, table: string) { this.items.set(this.key(table, item.PK, item.SK), structuredClone(item)); }
  get(pk: string, sk: string, table: string) { return this.items.get(this.key(table, pk, sk)); }
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
      const v = input.ExpressionAttributeValues ?? {};
      switch (cmd.constructor.name) {
        case 'GetCommand': return { Item: structuredClone(this.get(input.Key.PK, input.Key.SK, input.TableName)) };
        case 'PutCommand': this.put(input.Item, input.TableName); return {};
        case 'UpdateCommand': this.update(input.TableName, input); return {};
        case 'QueryCommand': {
          const rows = this.inTable(input.TableName);
          if (input.IndexName === 'GSI2') return { Items: structuredClone(rows.filter(i => i.GSI2PK === v[':pk'])) };
          if (input.IndexName) return { Items: [] };
          const hit = rows.filter(i => i.PK === v[':pk'] && i.SK.startsWith(v[':prefix'] ?? ''));
          return { Items: structuredClone(v[':registered'] ? hit.filter(i => i.status === v[':registered']) : hit) };
        }
        case 'ScanCommand': {
          const rows = this.inTable(input.TableName);
          if (v[':seriesId']) return { Items: structuredClone(rows.filter(i => i.SK === 'METADATA' && i.series_id === v[':seriesId'])) };
          return { Items: [] };
        }
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    }) as typeof ddb.send;
  }

  /** What every by-day reader sees: the sessions filed under that Israel day. */
  onDay(table: string, iso: string) {
    return this.inTable(table).filter(i => i.GSI2PK === `CLASSDATE#${israelDateStr(new Date(iso))}`).map(i => i.PK);
  }
}

const post = (uid: string, body: unknown) => ({ requestContext: { authorizer: { jwt: { claims: { sub: uid } } } }, body: JSON.stringify(body) }) as any;
const DAY = 24 * 60 * 60 * 1000;
/** A future instant at 18:00 Israel-ish (16:00Z), `days` from now — far from midnight so the day is unambiguous. */
const at = (days: number) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(16, 0, 0, 0); return d.toISOString(); };

function session(w: World, table: string, id: string, date: string, extra: Record<string, unknown> = {}) {
  w.put({
    PK: `CLASS#${id}`, SK: 'METADATA', GSI2PK: `CLASSDATE#${israelDateStr(new Date(date))}`, GSI2SK: `CLASS#${id}`,
    date, className: 'Session', currentAttendeesCount: 2, capacity: 10, ...extra,
  }, table);
  for (const uid of ['m1', 'm2']) {
    w.put({ PK: `CLASS#${id}`, SK: `REG#${uid}`, GSI1PK: `MEMBER#${uid}`, GSI1SK: `REG##${id}`, userId: uid, classId: id, classDate: date, status: 'REGISTERED', reminderSent: true, reminderSentAt: 'x', targetMonth: '2027-01' }, table);
  }
}

function world() {
  const w = new World();
  w.put({ PK: 'MEMBER#admin', SK: 'PROFILE', role: 'admin', identity: { role: 'admin' } }, 'incore');
  w.install();
  return w;
}

function assertMoved(w: World, table: string, id: string, from: string, to: string) {
  assert.ok(w.onDay(table, to).includes(`CLASS#${id}`), 'on its new day');
  assert.ok(!w.onDay(table, from).includes(`CLASS#${id}`), 'gone from its old day');
  const meta = w.get(`CLASS#${id}`, 'METADATA', table);
  assert.equal(meta.date, to);
  assert.equal(meta.GSI2SK, `CLASS#${id}`);
  assert.equal(meta.currentAttendeesCount, 2, 'counts stay');
  const regs = w.inTable(table).filter(i => i.PK === `CLASS#${id}` && i.SK.startsWith('REG#'));
  assert.equal(regs.length, 2, 'roster stays');
  for (const r of regs) {
    assert.equal(r.classDate, to, 'registrations follow the session');
    assert.equal(r.status, 'REGISTERED');
    assert.equal(r.targetMonth, '2027-01', 'the booking’s accounting month is kept');
    assert.equal(r.reminderSent, undefined, 'a reminder for the old day is cleared, so the new day gets one');
  }
}

test('FORCA: single-session edit moves the session to its new day (calendar, reminders, activity picker)', async () => {
  const w = world();
  const from = at(3); const to = at(5);
  session(w, 'forca', 'f1', from, { isSpecialActivity: true, groupId: 'g1' });
  w.put({ PK: 'APPCONFIG', SK: 'FORM_ASSIGNMENT#t#a', target: { kind: 'activity', classId: 'f1', date: from } }, 'forca');

  const res = await adminUpdateSessionInstance(post('admin', { classId: 'f1', date: to }));
  assert.equal(res.statusCode, 200, res.body);
  assertMoved(w, 'forca', 'f1', from, to);
  assert.equal(w.get('APPCONFIG', 'FORM_ASSIGNMENT#t#a', 'forca').target.classId, 'f1', 'attached forms point at the session, not the day');

  const picker = JSON.parse((await adminListActivities({ ...post('admin', {}), queryStringParameters: { brand: 'forca', days: '10' } })).body).activities;
  assert.deepEqual(picker.map((a: any) => [a.classId, a.date]), [['f1', to]], 'listed once, on the new day');
});

test('FORCA: a time-only change keeps the day and the sent reminder', async () => {
  const w = world();
  const from = at(3);
  const later = new Date(new Date(from).getTime() + 60 * 60 * 1000).toISOString();
  session(w, 'forca', 'f2', from);
  assert.equal((await adminUpdateSessionInstance(post('admin', { classId: 'f2', date: later }))).statusCode, 200);
  assert.ok(w.onDay('forca', later).includes('CLASS#f2'));
  for (const r of w.inTable('forca').filter(i => i.SK.startsWith('REG#'))) {
    assert.equal(r.classDate, later);
    assert.equal(r.reminderSent, true);
  }
});

test('INCORE: updateClass moves the class to its new day (member schedule, reminders)', async () => {
  const w = world();
  const from = at(4); const to = at(6);
  session(w, 'incore', 'i1', from);
  const res = await updateClass(post('admin', { classId: 'i1', date: to }));
  assert.equal(res.statusCode, 200, res.body);
  assertMoved(w, 'incore', 'i1', from, to);
});

test('INCORE: saveClassSeries moves the class and every shifted future sibling, with their bookings', async () => {
  const w = world();
  const from = at(2); const sib = at(9);
  session(w, 'incore', 's1', from, { series_id: 'ser' });
  session(w, 'incore', 's2', sib, { series_id: 'ser' });
  const to = new Date(new Date(at(3)).getTime() + 90 * 60 * 1000).toISOString(); // next day, 90 min later
  const res = await saveClassSeries(post('admin', { classId: 's1', date: to }));
  assert.equal(res.statusCode, 200, res.body);
  assertMoved(w, 'incore', 's1', from, to);
  const sibling = w.get('CLASS#s2', 'METADATA', 'incore');
  assert.notEqual(sibling.date, sib, 'sibling shifted to the new time');
  assert.equal(sibling.GSI2PK, `CLASSDATE#${israelDateStr(new Date(sibling.date))}`);
  for (const r of w.inTable('incore').filter(i => i.PK === 'CLASS#s2' && i.SK.startsWith('REG#'))) assert.equal(r.classDate, sibling.date);
});

test('repair plan (read-only): finds a session indexed on its old day and stale registration dates, nothing else', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const items = [
    // Moved with the old bug: date says the 20th, the index still says the 18th.
    { PK: 'CLASS#bad', SK: 'METADATA', date: '2026-11-20T16:00:00.000Z', GSI2PK: 'CLASSDATE#2026-11-18', GSI2SK: 'CLASS#bad', className: 'Moved' },
    { PK: 'CLASS#bad', SK: 'REG#m1', classDate: '2026-11-18T16:00:00.000Z', status: 'REGISTERED', reminderSent: true },
    { PK: 'CLASS#bad', SK: 'REG#m2', classDate: '2026-11-20T16:00:00.000Z', status: 'REGISTERED' },
    // Fine.
    { PK: 'CLASS#ok', SK: 'METADATA', date: '2026-11-21T16:00:00.000Z', GSI2PK: 'CLASSDATE#2026-11-21', GSI2SK: 'CLASS#ok' },
    { PK: 'CLASS#ok', SK: 'REG#m1', classDate: '2026-11-21T16:00:00.000Z', status: 'REGISTERED' },
    // Late evening UTC = next day in Israel — indexed correctly, not flagged.
    { PK: 'CLASS#late', SK: 'METADATA', date: '2026-11-21T22:30:00.000Z', GSI2PK: 'CLASSDATE#2026-11-22', GSI2SK: 'CLASS#late' },
    // Not a session.
    { PK: 'MEMBER#x', SK: 'PROFILE', date: '2026-11-21T16:00:00.000Z' },
  ];
  const plan = planDayIndexRepairs(items, now);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].classId, 'bad');
  assert.equal(plan[0].indexedDay, '2026-11-18');
  assert.deepEqual(plan[0].fixIndex, { GSI2PK: 'CLASSDATE#2026-11-20', GSI2SK: 'CLASS#bad' });
  assert.deepEqual(plan[0].staleRegistrations.map((r: any) => [r.SK, r.clearReminder]), [['REG#m1', true]]);
});
