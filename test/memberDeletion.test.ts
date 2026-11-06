import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceRecord, incoreClassCleanup } from '../src/lib/memberDeletion';

const ME = 'member-1';

test('INCORE: a class that never knew the member is left alone', () => {
  assert.equal(incoreClassCleanup({ allowedMemberIds: ['other'], waitlist: [] }, ME), null);
});

test('INCORE: a booking frees the attendee', () => {
  assert.deepEqual(incoreClassCleanup({}, ME, { status: 'REGISTERED' }), { attendees: -1 });
});

test('INCORE: a waitlisted member only leaves the waitlist', () => {
  const change = incoreClassCleanup({ waitlist: [{ member: ME }, { member: 'other' }] as never }, ME);
  assert.deepEqual(change, { waitlist: [{ member: 'other' }], attendees: 0 });
});

test('INCORE: a private class forgets the member, and an inactive booking changes no count', () => {
  const change = incoreClassCleanup({ allowedMemberIds: [ME] }, ME, { status: 'CANCELLED' });
  assert.deepEqual(change, { allowedMemberIds: [], attendees: 0 });
});

test('past attendance keeps the session details and the result', () => {
  const record = attendanceRecord(
    { date: '2026-10-01T15:00:00Z', className: 'בסיס', location: 'אולם', coachName: 'דנה' },
    { actualAttendance: 'present', declaredAttendance: 'yes' },
  );
  assert.deepEqual(record, { date: '2026-10-01T15:00:00Z', session: 'בסיס', location: 'אולם', coach: 'דנה', attendance: 'present', declared: 'yes' });
});
