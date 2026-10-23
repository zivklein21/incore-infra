// Run: npm test
// Saved-card (token) charges must never send a member's ID as HYP UserId —
// lib/hypClient.ts chargeHypToken. fetch is stubbed; nothing reaches HYP.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HYP_MASOF = 'TEST_MASOF';
process.env.HYP_KEY = 'TEST_KEY';
process.env.HYP_PASSP = 'TEST_PASSP';
// No TABLE_NAME: the terminal-override lookup fails fast and falls back to env.

test('chargeHypToken always sends UserId=000000000', async () => {
  const { chargeHypToken } = await import('../src/lib/hypClient');
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    sent.push(String(input));
    return new Response('CCode=0&Id=123&ACode=0012345');
  }) as typeof fetch;
  const realError = console.error;
  console.error = () => {};
  try {
    const result = await chargeHypToken({
      token: '1234567890123456789', expiryMonth: 2, expiryYear: 2030, amount: 72.5,
      clientName: 'Test Member', info: 'test',
    });
    assert.equal(result.success, true);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  const hypCall = sent.find((u) => u.includes('action=soft'));
  assert.ok(hypCall, 'a soft (token) charge request was sent');
  assert.equal(new URL(hypCall!).searchParams.get('UserId'), '000000000');
});
