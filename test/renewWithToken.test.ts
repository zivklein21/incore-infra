// Run: npm test
// renewSubscriptionWithToken: a declined renewal the member starts herself
// changes nothing — no membership expired, no booking evicted — and returns
// an error she can act on with another card.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';
process.env.HYP_MASOF = 'masof';
process.env.HYP_KEY = 'key';
process.env.HYP_PASSP = 'passp';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { handler, declinedRenewalResponse } = require('../src/functions/renewSubscriptionWithToken');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => { ddb.send = realSend; globalThis.fetch = realFetch; });

const UID = 'member-1';
const items: Record<string, unknown> = {
  [`MEMBER#${UID}|PROFILE`]: {
    identity: { firstName: 'Test', lastName: 'Member', email: 'm@example.com' },
    payment: { hypToken: 'tok', hypTokenExpiryMonth: 12, hypTokenExpiryYear: 2030, hypTokenProductId: 'fit' },
  },
  'PRODUCT#fit|METADATA': { name: 'Fit', type: 'subscription', active: true, price: 580, monthlyLimit: 8, weeklyLimit: 2 },
};

const ACTIVE_MEMBERSHIP = { PK: `MEMBER#${UID}`, SK: 'MEMBERSHIP#2026-11#m1', membershipId: 'm1', status: 'ACTIVE', targetMonth: '2026-11' };
const BOOKING = { PK: 'CLASS#c1', SK: `REG#${UID}`, classId: 'c1', status: 'REGISTERED', consumedFrom: 'FUTURE_SUBSCRIPTION', targetMonth: '2026-11' };
const WRITES = new Set(['PutCommand', 'UpdateCommand', 'DeleteCommand', 'TransactWriteCommand', 'BatchWriteCommand']);

/** Answers reads (gets from `items`, queries empty — e.g. the receipt-email family lookup); records every write. */
function stubDb(): string[] {
  const writes: string[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    if (cmd.constructor.name === 'GetCommand') return { Item: items[`${cmd.input.Key.PK}|${cmd.input.Key.SK}`] };
    if (WRITES.has(cmd.constructor.name)) { writes.push(cmd.constructor.name); return {}; }
    // She has a live membership and a booking — what the old code expired and evicted.
    const prefix = String(cmd.input.ExpressionAttributeValues?.[':prefix'] ?? '');
    if (prefix.startsWith('MEMBERSHIP#')) return { Items: [ACTIVE_MEMBERSHIP] };
    if (prefix.startsWith('REG#')) return { Items: [BOOKING] };
    return { Items: [] };
  }) as typeof ddb.send;
  return writes;
}

function stubHyp(body: string) {
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => body, json: async () => ({}) })) as unknown as typeof fetch;
}

const event = { body: '{}', requestContext: { authorizer: { jwt: { claims: { sub: UID } } } } };

test('declined renewal: 402 with a message and the option to use another card', async () => {
  const others = stubDb();
  stubHyp('CCode=6&Id=0');
  const res = await handler(event);
  assert.equal(res.statusCode, 402);
  const body = JSON.parse(res.body);
  assert.equal(body.success, false);
  assert.equal(body.error, 'charge_failed'); // unchanged for the app in the stores
  assert.equal(body.ccode, 6);
  assert.equal(body.canRetryWithNewCard, true);
  assert.match(body.message, /כרטיס אחר/);
  // Nothing expired or evicted: not a single write.
  assert.deepEqual(others, []);
});

test('declined renewal when HYP is unreachable: same, nothing touched', async () => {
  const others = stubDb();
  globalThis.fetch = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
  const res = await handler(event);
  assert.equal(res.statusCode, 402);
  assert.deepEqual(others, []);
});

test('the decline body keeps the old fields', () => {
  assert.deepEqual(Object.keys(declinedRenewalResponse(-1)).sort(), ['canRetryWithNewCard', 'ccode', 'error', 'message', 'success']);
});
