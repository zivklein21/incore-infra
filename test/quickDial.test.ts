import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { getSessionContacts, normalizePhone, parseEmergencyContact, saveEmergencyContact } = require('../src/lib/quickDial');
const { scrubForArchive } = require('../src/lib/memberArchive');

const realSend = ddb.send;
afterEach(() => { ddb.send = realSend; });

const COACH = { identity: { role: 'coach', groupIds: ['g1'], coachPermissions: { attendance: 'write' } } };

// Items keyed `table|PK|SK`. Registrations and family links answer the two Queries.
function stubTable(items: Record<string, unknown>, regs: { userId: string }[] = [], links: Record<string, string> = {}) {
  const updates: any[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: items[`${input.TableName}|${input.Key.PK}|${input.Key.SK}`] };
      case 'QueryCommand': {
        if (input.IndexName === 'GSI1') {
          const child = input.ExpressionAttributeValues[':pk'].replace('MEMBER#', '');
          return { Items: links[child] ? [{ parentUid: links[child] }] : [] };
        }
        return { Items: regs };
      }
      case 'UpdateCommand':
        updates.push(input);
        return {};
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  }) as typeof ddb.send;
  return updates;
}

const event = (uid: string, extra: Record<string, unknown>) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  ...extra,
}) as any;

const sessionEvent = (uid: string, classId = 'c1') => event(uid, { queryStringParameters: { classId } });
const saveEvent = (uid: string, body: unknown) => event(uid, { body: JSON.stringify(body) });

const sessionWorld = (overrides: Record<string, unknown> = {}) => ({
  'forca|MEMBER#coach1|PROFILE': COACH,
  'forca|CLASS#c1|METADATA': { groupId: 'g1', coachId: 'coach1' },
  'forca|MEMBER#t1|PROFILE': { identity: { phone: '0501111111', name: 'Trainee' }, emergencyContact: { name: 'Aunt', phone: '0503333333' } },
  'forca|MEMBER#t2|PROFILE': { identity: { name: 'No numbers' } },
  'forca|MEMBER#p1|PROFILE': { identity: { phone: '0502222222', name: 'Parent' } },
  ...overrides,
});

test('normalizePhone strips formatting and invisible direction marks', () => {
  assert.equal(normalizePhone('050-123 4567'), '0501234567');
  assert.equal(normalizePhone('‪+972 50-123-4567‬'), '+972501234567');
  assert.equal(normalizePhone('(03) 123-4567'), '031234567');
});

test('normalizePhone refuses things that are not numbers', () => {
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone('050+1234567'), null);
  assert.equal(normalizePhone(''), null);
});

test('an emergency contact needs both a name and a phone', () => {
  assert.deepEqual(parseEmergencyContact({ name: ' Dana ', phone: '050-1234567' }), { ok: true, contact: { name: 'Dana', phone: '0501234567' } });
  assert.deepEqual(parseEmergencyContact({ name: 'Dana', phone: '' }), { ok: false, error: 'invalid_phone' });
  assert.deepEqual(parseEmergencyContact({ name: '', phone: '0501234567' }), { ok: false, error: 'invalid_name' });
  assert.deepEqual(parseEmergencyContact({ name: 'x'.repeat(81), phone: '0501234567' }), { ok: false, error: 'invalid_name' });
});

test('null or a blank contact clears it; a missing one is refused', () => {
  assert.deepEqual(parseEmergencyContact(null), { ok: true, contact: null });
  assert.deepEqual(parseEmergencyContact({ name: ' ', phone: '' }), { ok: true, contact: null });
  assert.equal(parseEmergencyContact(undefined).ok, false);
});

test('the coach of a session gets her roster, and only numbers that exist', async () => {
  stubTable(sessionWorld(), [{ userId: 't1' }, { userId: 't2' }], { t1: 'p1' });
  const res = await getSessionContacts(sessionEvent('coach1'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body as string).contacts, {
    t1: {
      phone: '0501111111',
      parent: { name: 'Parent', phone: '0502222222' },
      emergency: { name: 'Aunt', phone: '0503333333' },
    },
    t2: { phone: null, parent: null, emergency: null },
  });
});

test('a parent with no phone on file is left out', async () => {
  stubTable(sessionWorld({ 'forca|MEMBER#p1|PROFILE': { identity: { name: 'Parent' } } }), [{ userId: 't1' }], { t1: 'p1' });
  const res = await getSessionContacts(sessionEvent('coach1'));
  assert.equal(JSON.parse(res.body as string).contacts.t1.parent, null);
});

const assertNoContacts = (res: { statusCode: number; body: string }) => {
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { contacts: {} });
};

test('a coach in the same group gets nothing for another coach\'s session', async () => {
  stubTable(sessionWorld({ 'forca|CLASS#c1|METADATA': { groupId: 'g1', coachId: 'coach2' } }), [{ userId: 't1' }]);
  assertNoContacts(await getSessionContacts(sessionEvent('coach1')));
});

test('a coach gets nothing for her session once its group is no longer hers', async () => {
  stubTable(sessionWorld({ 'forca|CLASS#c1|METADATA': { groupId: 'g2', coachId: 'coach1' } }), [{ userId: 't1' }]);
  assertNoContacts(await getSessionContacts(sessionEvent('coach1')));
});

test('a coach with no attendance access gets nothing', async () => {
  stubTable(sessionWorld({
    'forca|MEMBER#coach1|PROFILE': { identity: { role: 'coach', groupIds: ['g1'], coachPermissions: { attendance: 'none' } } },
  }), [{ userId: 't1' }]);
  assertNoContacts(await getSessionContacts(sessionEvent('coach1')));
});

test('a trainee or parent gets nothing', async () => {
  stubTable(sessionWorld(), [{ userId: 't1' }], { t1: 'p1' });
  assert.equal((await getSessionContacts(sessionEvent('t1'))).statusCode, 403);
  assert.equal((await getSessionContacts(sessionEvent('p1'))).statusCode, 403);
});

test('an admin can read any session', async () => {
  stubTable(sessionWorld({
    'incore|MEMBER#admin1|PROFILE': { role: 'admin' },
    'forca|CLASS#c1|METADATA': { groupId: 'g9', coachId: 'coach2' },
  }), [{ userId: 't1' }]);
  assert.equal((await getSessionContacts(sessionEvent('admin1'))).statusCode, 200);
});

const saveWorld = {
  'forca|MEMBER#p1|PROFILE': { identity: { phone: '0502222222' } },
  'forca|MEMBER#p1|FAMILY#t1': { parentUid: 'p1', childUid: 't1' },
  'forca|MEMBER#t1|PROFILE': { identity: {} },
  'forca|MEMBER#coach1|PROFILE': COACH,
  'incore|MEMBER#admin1|PROFILE': { role: 'admin' },
};
const contact = { name: 'Dana', phone: '050-123 4567' };

test('a linked parent can set the emergency contact, stored normalized', async () => {
  const updates = stubTable(saveWorld);
  const res = await saveEmergencyContact(saveEvent('p1', { memberId: 't1', contact }));
  assert.equal(res.statusCode, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].TableName, 'forca');
  assert.deepEqual(updates[0].Key, { PK: 'MEMBER#t1', SK: 'PROFILE' });
  assert.deepEqual(updates[0].ExpressionAttributeValues[':contact'], { name: 'Dana', phone: '0501234567' });
});

test('an admin can set it with no family link', async () => {
  const updates = stubTable(saveWorld);
  assert.equal((await saveEmergencyContact(saveEvent('admin1', { memberId: 't1', contact }))).statusCode, 200);
  assert.equal(updates.length, 1);
});

test('clearing removes the attribute', async () => {
  const updates = stubTable(saveWorld);
  await saveEmergencyContact(saveEvent('p1', { memberId: 't1', contact: null }));
  assert.equal(updates[0].UpdateExpression, 'REMOVE emergencyContact');
});

test('the trainee, a coach and an unlinked parent cannot edit it', async () => {
  const updates = stubTable({ ...saveWorld, 'forca|MEMBER#p2|PROFILE': { identity: {} } });
  for (const uid of ['t1', 'coach1', 'p2']) {
    assert.equal((await saveEmergencyContact(saveEvent(uid, { memberId: 't1', contact }))).statusCode, 403, uid);
  }
  assert.equal(updates.length, 0);
});

test('a bad number is refused before anything is written', async () => {
  const updates = stubTable(saveWorld);
  const res = await saveEmergencyContact(saveEvent('p1', { memberId: 't1', contact: { name: 'Dana', phone: 'nope' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(updates.length, 0);
});

test('an unknown member is a 404, not a new profile row', async () => {
  stubTable(saveWorld);
  ddb.send = ((send) => async (cmd: any) => {
    if (cmd.constructor.name === 'UpdateCommand') throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
    return send(cmd);
  })(ddb.send);
  assert.equal((await saveEmergencyContact(saveEvent('admin1', { memberId: 'ghost', contact }))).statusCode, 404);
});

test('the emergency contact is a third party\'s data and is not archived', () => {
  assert.deepEqual(scrubForArchive({ forms: {}, emergencyContact: contact }), { forms: {} });
});
