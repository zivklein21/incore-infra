import test from 'node:test';
import assert from 'node:assert/strict';
import { ddb } from '../src/lib/dynamo';
import { removeFromClasses } from '../src/lib/memberDeletion';

const ME = 'member-1';
const FUTURE = '2099-01-10T17:00:00.000Z';
const PAST = '2020-01-10T17:00:00.000Z';

function run(brand: 'incore' | 'forca', classes: unknown[], regs: unknown[]) {
  const calls: { type: string; input: any }[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const type = cmd.constructor.name;
    if (type === 'QueryCommand') return { Items: regs };
    if (type === 'ScanCommand') return { Items: classes };
    calls.push({ type, input: cmd.input });
    return {};
  }) as never;
  return removeFromClasses('table', { memberId: ME, brand, isTest: false, archivedAt: '2026-11-06T10:00:00.000Z', birthday: undefined }).then(() => calls);
}

const reg = (classId: string, classDate: string, consumedFrom: string) => ({
  PK: `CLASS#${classId}`, SK: `REG#${ME}`, userId: ME, classId, classDate, status: 'REGISTERED', consumedFrom,
});

test('INCORE: a future booking frees one seat and leaves capacity alone', async () => {
  const calls = await run('incore', [
    { PK: 'CLASS#booked', SK: 'METADATA', date: FUTURE, capacity: 12, currentAttendeesCount: 12, waitlist: [] },
  ], [reg('booked', FUTURE, 'MEMBERSHIP')]);

  const update = calls.find((c) => c.type === 'UpdateCommand');
  assert.equal(update?.input.UpdateExpression, 'ADD currentAttendeesCount :attendees');
  assert.equal(update?.input.ExpressionAttributeValues[':attendees'], -1);
  assert.deepEqual(calls.find((c) => c.type === 'DeleteCommand')?.input.Key, { PK: 'CLASS#booked', SK: `REG#${ME}` });
});

test('INCORE: a waitlist spot goes, and the attendee count does not change', async () => {
  const other = { member: 'other', since: FUTURE, status: 'waiting' };
  const calls = await run('incore', [
    { PK: 'CLASS#full', SK: 'METADATA', date: FUTURE, capacity: 12, currentAttendeesCount: 12, waitlist: [{ member: ME, since: FUTURE, status: 'waiting' }, other] },
  ], []);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.UpdateExpression, 'SET waitlist = :waitlist');
  assert.deepEqual(calls[0].input.ExpressionAttributeValues[':waitlist'], [other]);
});

test('INCORE: both at once touch only their own classes', async () => {
  const calls = await run('incore', [
    { PK: 'CLASS#booked', SK: 'METADATA', date: FUTURE, capacity: 12, currentAttendeesCount: 5 },
    { PK: 'CLASS#full', SK: 'METADATA', date: FUTURE, capacity: 12, currentAttendeesCount: 12, waitlist: [{ member: ME, since: FUTURE, status: 'waiting' }] },
    { PK: 'CLASS#unrelated', SK: 'METADATA', date: FUTURE, capacity: 12, currentAttendeesCount: 3 },
  ], [reg('booked', FUTURE, 'EXTRA_PUNCH')]);

  const updated = calls.filter((c) => c.type === 'UpdateCommand').map((c) => c.input.Key.PK).sort();
  assert.deepEqual(updated, ['CLASS#booked', 'CLASS#full']);
});

test('INCORE: a past class keeps its count and the attendance is archived', async () => {
  const calls = await run('incore', [
    { PK: 'CLASS#old', SK: 'METADATA', date: PAST, capacity: 12, currentAttendeesCount: 8, className: 'Pilates', location: 'A', coachName: 'Dana' },
  ], [{ ...reg('old', PAST, 'MEMBERSHIP'), actualAttendance: 'present' }]);

  assert.equal(calls.filter((c) => c.type === 'UpdateCommand').length, 0);
  const archived = calls.find((c) => c.type === 'PutCommand')?.input.Item;
  assert.equal(archived.kind, 'attendance');
  assert.equal(archived.item.attendance, 'present');
});

test('FORCA: an auto-registered future session also gives back its added seat', async () => {
  const calls = await run('forca', [
    { PK: 'CLASS#session', SK: 'METADATA', date: FUTURE, capacity: 6, currentAttendeesCount: 6, allowedMemberIds: [ME, 'other'] },
  ], [reg('session', FUTURE, 'FORCA_AUTO')]);

  const update = calls.find((c) => c.type === 'UpdateCommand');
  assert.equal(update?.input.ExpressionAttributeValues[':capacity'], -1);
  assert.equal(update?.input.ExpressionAttributeValues[':attendees'], -1);
  assert.deepEqual(update?.input.ExpressionAttributeValues[':ids'], ['other']);
});

test('INCORE: capacity never changes, even if a booking were marked FORCA_AUTO', async () => {
  const calls = await run('incore', [
    { PK: 'CLASS#x', SK: 'METADATA', date: FUTURE, capacity: 12, currentAttendeesCount: 12 },
  ], [reg('x', FUTURE, 'FORCA_AUTO')]);
  assert.equal(calls.find((c) => c.type === 'UpdateCommand')?.input.ExpressionAttributeValues[':capacity'], undefined);
});
