import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceRecord, classCleanup } from '../src/lib/memberDeletion';

const ME = 'member-1';

test('a class that never knew the member is left alone', () => {
  assert.equal(classCleanup('incore', { allowedMemberIds: ['other'], waitlist: [] }, ME), null);
});

test('a FORCA auto-registered member frees the attendee and the added seat', () => {
  const change = classCleanup('forca', { allowedMemberIds: [ME, 'other'] }, ME, { status: 'REGISTERED', consumedFrom: 'FORCA_AUTO' });
  assert.deepEqual(change, { allowedMemberIds: ['other'], attendees: -1, capacity: -1 });
});

test('an INCORE booking frees the attendee but not the class capacity', () => {
  const change = classCleanup('incore', {}, ME, { status: 'REGISTERED', consumedFrom: 'MEMBERSHIP' });
  assert.deepEqual(change, { attendees: -1, capacity: 0 });
});

test('a waitlisted member only leaves the waitlist', () => {
  const change = classCleanup('incore', { waitlist: [{ member: ME }, { member: 'other' }] as never }, ME);
  assert.deepEqual(change, { waitlist: [{ member: 'other' }], attendees: 0, capacity: 0 });
});

test('a registration that is not active does not change the attendee count', () => {
  const change = classCleanup('incore', { allowedMemberIds: [ME] }, ME, { status: 'CANCELLED', consumedFrom: 'MEMBERSHIP' });
  assert.deepEqual(change, { allowedMemberIds: [], attendees: 0, capacity: 0 });
});

test('past attendance keeps the session details and the result', () => {
  const record = attendanceRecord(
    { date: '2026-10-01T15:00:00Z', className: 'בסיס', location: 'אולם', coachName: 'דנה' },
    { actualAttendance: 'present', declaredAttendance: 'yes' },
  );
  assert.deepEqual(record, { date: '2026-10-01T15:00:00Z', session: 'בסיס', location: 'אולם', coach: 'דנה', attendance: 'present', declared: 'yes' });
});
