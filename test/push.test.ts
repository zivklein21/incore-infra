// Run: npm test
// Expo push reply handling — lib/push.ts. Pure functions only, no DynamoDB
// or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, classifyReceipts, classifyTickets, maskPushToken, type ExpoPushMessage } from '../src/lib/push';

const msg = (to: string): ExpoPushMessage => ({ to, title: 't', body: 'b' });

test('maskPushToken keeps only the first 4 token characters', () => {
  assert.equal(maskPushToken('ExponentPushToken[abcdefghijklmnop]'), 'ExponentPushToken[abcd…]');
  assert.equal(maskPushToken('ExpoPushToken[xyz123456]'), 'ExpoPushToken[xyz1…]');
  assert.equal(maskPushToken('garbage-token'), 'garb…');
});

test('chunk splits into fixed-size batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 100), []);
});

test('classifyTickets pairs tickets with messages by position', () => {
  const messages = [msg('A'), msg('B'), msg('C')];
  const { accepted, errors } = classifyTickets(messages, [
    { status: 'ok', id: 't1' },
    { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    { status: 'ok', id: 't3' },
  ]);
  assert.deepEqual(accepted, [{ id: 't1', token: 'A' }, { id: 't3', token: 'C' }]);
  assert.deepEqual(errors, [{ token: 'B', code: 'DeviceNotRegistered', message: 'gone' }]);
});

test('classifyTickets reports a missing ticket and an error without details', () => {
  const { accepted, errors } = classifyTickets([msg('A'), msg('B')], [{ status: 'error', message: 'bad' }]);
  assert.deepEqual(accepted, []);
  assert.deepEqual(errors, [
    { token: 'A', code: 'Unknown', message: 'bad' },
    { token: 'B', code: 'NoTicket', message: 'Expo returned no ticket for this message' },
  ]);
});

test('classifyReceipts: ok and error receipts are done, missing ones stay pending', () => {
  const tickets = [
    { ticketId: 't1', token: 'A' },
    { ticketId: 't2', token: 'B' },
    { ticketId: 't3', token: 'C' },
  ];
  const { done, pending, errors } = classifyReceipts(tickets, {
    t1: { status: 'ok' },
    t2: { status: 'error', message: 'FCM credentials invalid', details: { error: 'InvalidCredentials' } },
  });
  assert.deepEqual(done.map((t) => t.ticketId), ['t1', 't2']);
  assert.deepEqual(pending.map((t) => t.ticketId), ['t3']);
  assert.deepEqual(errors, [{ token: 'B', code: 'InvalidCredentials', message: 'FCM credentials invalid' }]);
});
