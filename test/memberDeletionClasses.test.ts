import test from 'node:test';
import assert from 'node:assert/strict';
import { ddb } from '../src/lib/dynamo';
import { removeFromClasses } from '../src/lib/memberDeletion';

const ME = 'member-1';
const FUTURE = '2099-01-10T17:00:00.000Z';
const PAST = '2020-01-10T17:00:00.000Z';
const PROFILE = { PK: `MEMBER#${ME}`, SK: 'PROFILE' };

function run(brand: 'incore' | 'forca', classes: unknown[], regs: unknown[]) {
  const calls: { type: string; input: any }[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const type = cmd.constructor.name;
    if (type === 'QueryCommand') return { Items: regs };
    if (type === 'ScanCommand') return { Items: classes };
    calls.push({ type, input: cmd.input });
    return {};
  }) as never;
  const ctx = { memberId: ME, brand, isTest: false, archivedAt: '2026-11-06T10:00:00.000Z', birthday: undefined };
  return removeFromClasses('table', ctx, PROFILE).then(() => calls);
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

test('INCORE: capacity is never written', async () => {
  const calls = await run('incore', [
    { PK: 'CLASS#x', SK: 'METADATA', date: FUTURE, capacity: 12, currentAttendeesCount: 12, allowedMemberIds: [ME] },
  ], [reg('x', FUTURE, 'MEMBERSHIP')]);
  assert.ok(calls.every((c) => !String(c.input.UpdateExpression ?? '').includes('capacity')));
});

test('FORCA: the trainee leaves her group, and the group change comes first', async () => {
  const calls = await run('forca', [], []);
  assert.equal(calls[0].type, 'UpdateCommand');
  assert.deepEqual(calls[0].input.Key, PROFILE);
  assert.equal(calls[0].input.UpdateExpression, 'REMOVE #identity.groupId');
});

test('FORCA: a future session loses her from the roster and nothing else', async () => {
  const calls = await run('forca', [
    { PK: 'CLASS#next', SK: 'METADATA', date: FUTURE, groupId: 'g1', capacity: 6, currentAttendeesCount: 6, waitlist: [], allowedMemberIds: [ME, 'other'] },
  ], [reg('next', FUTURE, 'FORCA_AUTO')]);

  const update = calls.find((c) => c.input.Key?.PK === 'CLASS#next' && c.type === 'UpdateCommand');
  assert.equal(update?.input.UpdateExpression, 'SET allowedMemberIds = :ids');
  assert.deepEqual(update?.input.ExpressionAttributeValues, { ':ids': ['other'] });
  assert.deepEqual(calls.find((c) => c.type === 'DeleteCommand')?.input.Key, { PK: 'CLASS#next', SK: `REG#${ME}` });
});

test('FORCA: a past session is left as it was, and the attendance is archived', async () => {
  const calls = await run('forca', [
    { PK: 'CLASS#old', SK: 'METADATA', date: PAST, groupId: 'g1', capacity: 6, currentAttendeesCount: 6, allowedMemberIds: [ME], className: 'בסיס' },
  ], [{ ...reg('old', PAST, 'FORCA_AUTO'), actualAttendance: 'absent' }]);

  assert.equal(calls.filter((c) => c.input.Key?.PK === 'CLASS#old' && c.type === 'UpdateCommand').length, 0);
  const archived = calls.find((c) => c.type === 'PutCommand')?.input.Item;
  assert.equal(archived.kind, 'attendance');
  assert.equal(archived.item.attendance, 'absent');
});

test('FORCA: a group with future and past sessions never writes capacity, counts or a waitlist', async () => {
  const calls = await run('forca', [
    { PK: 'CLASS#next', SK: 'METADATA', date: FUTURE, capacity: 6, currentAttendeesCount: 6, allowedMemberIds: [ME] },
    { PK: 'CLASS#old', SK: 'METADATA', date: PAST, capacity: 6, currentAttendeesCount: 6, allowedMemberIds: [ME] },
  ], [reg('next', FUTURE, 'FORCA_AUTO'), reg('old', PAST, 'FORCA_AUTO')]);

  for (const c of calls) {
    const expression = String(c.input.UpdateExpression ?? '');
    assert.ok(!/capacity|currentAttendeesCount|waitlist/.test(expression), expression);
  }
});
