// Run: npm test
// Email helpers — lib/mailer.ts formatting and lib/sesEvents.ts log lines.
// Pure functions only, no SES/Gmail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFromAddress, maskEmailForLog } from '../src/lib/mailer';
import { describeSesEvent } from '../src/lib/sesEvents';

test('maskEmailForLog keeps the first letter and the domain', () => {
  assert.equal(maskEmailForLog('ziv@gmail.com'), 'z***@gmail.com');
  assert.equal(maskEmailForLog('not-an-email'), '***');
});

test('formatFromAddress quotes the display name and escapes quotes', () => {
  assert.equal(formatFromAddress('INCORE', 'no-reply@incoretraining.com'), '"INCORE" <no-reply@incoretraining.com>');
  assert.equal(formatFromAddress('A "B"', 'x@y.com'), '"A \\"B\\"" <x@y.com>');
});

test('bounce: one masked line per recipient, with diagnostic', () => {
  const lines = describeSesEvent({
    eventType: 'Bounce',
    mail: { messageId: 'm1' },
    bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [
      { emailAddress: 'alice@example.com', diagnosticCode: '550 no such user' },
      { emailAddress: 'bob@example.com' },
    ] },
  });
  assert.deepEqual(lines, [
    'Bounce Permanent/General to=a***@example.com msg=m1 diag="550 no such user"',
    'Bounce Permanent/General to=b***@example.com msg=m1',
  ]);
  assert.ok(lines.every((l) => !l.includes('alice') && !l.includes('bob')));
});

test('complaint, reject and unknown events', () => {
  assert.deepEqual(describeSesEvent({ eventType: 'Complaint', mail: { messageId: 'm2' }, complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'c@d.com' }] } }),
    ['Complaint abuse to=c***@d.com msg=m2']);
  assert.deepEqual(describeSesEvent({ eventType: 'Reject', mail: { messageId: 'm3' }, reject: { reason: 'Bad content' } }),
    ['Reject reason="Bad content" msg=m3']);
  assert.deepEqual(describeSesEvent({ eventType: 'Open' }), ['Open msg=?']);
});
