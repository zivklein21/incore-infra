// Run: npm test
// lib/cognitoEmail.ts — what the Cognito Custom Email Sender sends. Pure, no AWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCognitoEmail, emailKindForTrigger, pickBrand } from '../src/lib/cognitoEmail';
import { MAIL_PROVIDER } from '../src/lib/mailer';

test('trigger sources map to the right email, unknown ones send nothing', () => {
  assert.equal(emailKindForTrigger('CustomEmailSender_ForgotPassword'), 'reset');
  assert.equal(emailKindForTrigger('CustomEmailSender_SignUp'), 'verify');
  assert.equal(emailKindForTrigger('CustomEmailSender_ResendCode'), 'verify');
  assert.equal(emailKindForTrigger('CustomEmailSender_UpdateUserAttribute'), 'verify');
  assert.equal(emailKindForTrigger('CustomEmailSender_VerifyUserAttribute'), 'verify');
  assert.equal(emailKindForTrigger('CustomEmailSender_AdminCreateUser'), 'invite');
  assert.equal(emailKindForTrigger('CustomEmailSender_AccountTakeOverNotification'), null);
});

test('brand: INCORE wins, then FORCA, unknown accounts are INCORE', () => {
  assert.equal(pickBrand(true, true), 'incore');
  assert.equal(pickBrand(false, true), 'forca');
  assert.equal(pickBrand(false, false), 'incore');
});

test('reset email carries the code and the member brand as sender name', () => {
  const forca = buildCognitoEmail('reset', 'forca', '123456');
  assert.equal(forca.senderName, 'FORCA');
  assert.match(forca.subject, /FORCA/);
  assert.ok(forca.html.includes('123456'));
  assert.ok(forca.html.includes('#7A004B'));
  const incore = buildCognitoEmail('reset', 'incore', '654321');
  assert.equal(incore.senderName, 'INCORE');
  assert.ok(!incore.html.includes('FORCA'));
});

test('an invitation password is HTML-escaped', () => {
  const mail = buildCognitoEmail('invite', 'incore', 'a<b>&"');
  assert.ok(mail.html.includes('a&lt;b&gt;&amp;&quot;'));
  assert.ok(!mail.html.includes('a<b>'));
});

test('mailer sends through SES only (no Gmail fallback)', () => {
  assert.equal(MAIL_PROVIDER, 'ses');
});
