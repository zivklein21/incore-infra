// Run: npm test
// Israeli ID normalization + check digit — lib/israeliId.ts. The IDs below
// are synthetic (built to pass/fail the check digit), not real people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIsraeliId, normalizeIsraeliId } from '../src/lib/israeliId';

test('a leading zero is kept, never dropped', () => {
  assert.equal(normalizeIsraeliId('012345674'), '012345674');
  assert.ok(isValidIsraeliId('012345674'));
});

test('an 8-digit ID (zero already lost) is padded back to 9', () => {
  assert.equal(normalizeIsraeliId('12345674'), '012345674');
  assert.ok(isValidIsraeliId('12345674'));
});

test('spaces and dashes are stripped', () => {
  assert.equal(normalizeIsraeliId(' 01-234 5674 '), '012345674');
  assert.equal(normalizeIsraeliId('1234-5674'), '012345674');
  assert.ok(isValidIsraeliId('01-234-5674'));
});

test('check digit: one wrong digit is rejected', () => {
  assert.ok(isValidIsraeliId('123456782'));
  assert.ok(!isValidIsraeliId('123456781'));
  assert.ok(!isValidIsraeliId('012345675'));
});

test('empty, all-zero and too-long inputs are invalid', () => {
  assert.equal(normalizeIsraeliId(''), '');
  assert.equal(normalizeIsraeliId('abc'), '');
  assert.ok(!isValidIsraeliId(''));
  assert.ok(!isValidIsraeliId('000000000'));
  assert.ok(!isValidIsraeliId('1234567890'));
});
