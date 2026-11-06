import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRow, deleteAfterFor, scrubForArchive } from '../src/lib/memberArchive';

test('legally needed rows are kept', () => {
  assert.equal(classifyRow({ PK: 'FORMSUB#t1', SK: 'c#a#1' }), 'signed_form');
  assert.equal(classifyRow({ PK: 'PHOTOCONSENT#c', SK: 'LOG#1' }), 'photo_consent');
  assert.equal(classifyRow({ PK: 'FORM_AUDIT', SK: '2026#x' }), 'signature_audit');
  assert.equal(classifyRow({ PK: 'FORCASUBORDER#1', SK: 'METADATA' }), 'payment');
  assert.equal(classifyRow({ PK: 'MERCHORDER#1', SK: 'METADATA' }), 'payment');
  assert.equal(classifyRow({ PK: 'ORDER#1', SK: 'METADATA' }), 'payment');
  assert.equal(classifyRow({ PK: 'FORCAAGREEMENT#1', SK: 'METADATA' }), 'payment');
  assert.equal(classifyRow({ PK: 'AGREEMENT#1', SK: 'METADATA' }), 'payment');
});

test('personal app data is not kept', () => {
  assert.equal(classifyRow({ PK: 'MEMBER#1', SK: 'MESSAGE#x' }), null);
  assert.equal(classifyRow({ PK: 'MEMBER#1', SK: 'FAMILY#2' }), null);
  assert.equal(classifyRow({ PK: 'EXERCISELOG#1', SK: 'METADATA' }), null);
  assert.equal(classifyRow({ PK: 'INQUIRY#1', SK: 'METADATA' }), null);
  assert.equal(classifyRow({ PK: 'WEEKLYTASK#1', SK: 'COMPLETION#1' }), null);
});

test('no card or push token survives into the archive, at any depth', () => {
  const scrubbed = scrubForArchive({
    token: 'card', tokenExpiryMonth: 10, hypToken: 'x', amount: 5, payment: { hasSavedCard: true },
    device: { expo_push_token: 'y' }, expoPushToken: 'z', photoKey: 'p', GSI1PK: 'g',
    forms: { nested: [{ pushToken: 'q', answer: 'keep' }] },
  });
  assert.deepEqual(scrubbed, { amount: 5, forms: { nested: [{ answer: 'keep' }] } });
});

test('an adult goes 7 years after archiving', () => {
  assert.equal(deleteAfterFor('2026-11-06T10:00:00.000Z', '1990-01-01'), Date.UTC(2033, 10, 6, 10, 0, 0) / 1000);
});

test('with no birthday it is 7 years after archiving', () => {
  assert.equal(deleteAfterFor('2026-11-06T10:00:00.000Z'), Date.UTC(2033, 10, 6, 10, 0, 0) / 1000);
});

test('a minor goes 7 years after their 18th birthday, when that is later', () => {
  assert.equal(deleteAfterFor('2026-11-06T10:00:00.000Z', '2016-05-01'), Date.UTC(2041, 4, 1) / 1000);
});

test('a young adult archived late still gets 7 years from archiving', () => {
  assert.equal(deleteAfterFor('2040-01-01T00:00:00.000Z', '2016-05-01'), Date.UTC(2047, 0, 1) / 1000);
});
