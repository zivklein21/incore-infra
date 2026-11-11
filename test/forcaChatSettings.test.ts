import test from 'node:test';
import assert from 'node:assert/strict';
import { autoReplyFor, FORCA_CHAT_DEFAULTS, parseForcaChatSettings, validateForcaChatSettings } from '../src/lib/forcaChat/settings';

test('defaults until the admin saves', () => {
  assert.deepEqual(parseForcaChatSettings(undefined), FORCA_CHAT_DEFAULTS);
  assert.equal(autoReplyFor(FORCA_CHAT_DEFAULTS, 'admin'), FORCA_CHAT_DEFAULTS.autoReply);
  assert.equal(autoReplyFor(FORCA_CHAT_DEFAULTS, 'coach'), FORCA_CHAT_DEFAULTS.coachAutoReply);
});

test('an empty text turns that auto-reply off', () => {
  const s = parseForcaChatSettings({ subjects: ['א'], autoReply: '', coachAutoReply: '  ' });
  assert.equal(autoReplyFor(s, 'admin'), null);
  assert.equal(autoReplyFor(s, 'coach'), null);
});

test('saving validates and tidies', () => {
  assert.deepEqual(
    validateForcaChatSettings({ subjects: [' א ', 'א', 'ב', ''], autoReply: ' hi ', coachAutoReply: 'yo' }),
    { subjects: ['א', 'ב'], autoReply: 'hi', coachAutoReply: 'yo' },
  );
  assert.equal(validateForcaChatSettings({ subjects: [], autoReply: 'x' }), null, 'at least one subject');
  assert.equal(validateForcaChatSettings({ subjects: ['א'], autoReply: 5 }), null);
  assert.equal(validateForcaChatSettings({ subjects: ['א'], autoReply: 'x'.repeat(1001) }), null);
  assert.equal(validateForcaChatSettings({ subjects: ['א'], autoReply: 'x' })?.coachAutoReply, FORCA_CHAT_DEFAULTS.coachAutoReply, 'older body without the coach text keeps the default');
});
