import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChargeSafety, chargeBlockReason } from '../src/lib/chargeSafety';

test('a healthy subscription is charged', () => {
  assert.equal(chargeBlockReason([{}, {}], 'token'), null);
});

test('a missing member blocks the charge, whichever one it is', () => {
  assert.equal(chargeBlockReason([undefined, {}], 'token'), 'member_missing');
  assert.equal(chargeBlockReason([{}, undefined], 'token'), 'member_missing');
});

test('a member being deleted blocks the charge', () => {
  assert.equal(chargeBlockReason([{ deletionPending: true }], 'token'), 'deletion_pending');
});

test('no card blocks the charge', () => {
  assert.equal(chargeBlockReason([{}], ''), 'no_token');
});

test('report mode never stops a charge, and neither does a missing setting', () => {
  delete process.env.CHARGE_SAFETY_MODE;
  assert.equal(applyChargeSafety('incore', 'a', 'u', 'no_token'), false);
  process.env.CHARGE_SAFETY_MODE = 'report';
  assert.equal(applyChargeSafety('incore', 'a', 'u', 'no_token'), false);
});

test('enforce mode stops the charge', () => {
  process.env.CHARGE_SAFETY_MODE = 'enforce';
  assert.equal(applyChargeSafety('forca', 'a', 'u', 'member_missing'), true);
  delete process.env.CHARGE_SAFETY_MODE;
});
