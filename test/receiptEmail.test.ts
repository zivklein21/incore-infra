import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';
process.env.HYP_MASOF = 'masof';
process.env.HYP_KEY = 'key';
process.env.HYP_PASSP = 'passp';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { resolveReceiptEmail } = require('../src/lib/receiptEmail');
const { chargeOneAgreement } = require('../src/lib/hypBillingAgreements');
const { chargeOneForcaAgreement } = require('../src/lib/forcaBillingAgreements');
const { handler: merchTokenPurchase } = require('../src/functions/createForcaMerchTokenPurchase');
const { handler: merchPaymentPage } = require('../src/functions/createMerchPaymentPage');
const { handler: hypPaymentPage } = require('../src/functions/createHypPaymentPage');
const { handler: hypTokenPurchase } = require('../src/functions/createHypTokenPurchase');
const { handler: renewWithToken } = require('../src/functions/renewSubscriptionWithToken');

const realSend = ddb.send;
const realFetch = globalThis.fetch;
afterEach(() => {
  ddb.send = realSend;
  globalThis.fetch = realFetch;
  mock.restoreAll();
});

const CHILD = 'child-1';
const PARENT = 'parent-1';
const CHILD_EMAIL = 'child@example.com';
const PARENT_EMAIL = 'parent@example.com';

const profile = (email?: string) => ({
  identity: { firstName: 'Test', lastName: 'Member', ...(email ? { email } : {}) },
  payment: { hypToken: 'tok', hypTokenExpiryMonth: 12, hypTokenExpiryYear: 2030 },
});

// Items keyed `table|PK|SK`. `links` maps child uid to parent uid per table,
// and answers the FAMILYOF# query only, so any other GSI1 query comes back empty.
function stubDb(items: Record<string, unknown>, links: Record<string, Record<string, string>> = {}) {
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: items[`${input.TableName}|${input.Key.PK}|${input.Key.SK}`] };
      case 'QueryCommand': {
        if (input.ExpressionAttributeValues?.[':prefix'] !== 'FAMILYOF#') return { Items: [] };
        const child = input.ExpressionAttributeValues[':pk'].replace('MEMBER#', '');
        const parentUid = links[input.TableName]?.[child];
        return { Items: parentUid ? [{ parentUid }] : [] };
      }
      default:
        return {};
    }
  }) as typeof ddb.send;
}

// Answers HYP with a success and records the params of each pay.hyp.co.il call.
function stubHyp(body: string) {
  const calls: URLSearchParams[] = [];
  globalThis.fetch = (async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'pay.hyp.co.il') calls.push(parsed.searchParams);
    return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return calls;
}

const CHARGED = 'CCode=0&Id=555&ACode=1';
const SIGNED = 'action=pay&signature=abc';

const member = (table: string, uid: string, email?: string) => ({ [`${table}|MEMBER#${uid}|PROFILE`]: profile(email) });

// ─── resolveReceiptEmail ───────────────────────────────────────────────────

test('a linked member gets the parent email', async () => {
  stubDb({ ...member('forca', PARENT, PARENT_EMAIL) }, { forca: { [CHILD]: PARENT } });
  assert.equal(await resolveReceiptEmail('forca', CHILD, CHILD_EMAIL), PARENT_EMAIL);
});

test('a member with no family link keeps their own email', async () => {
  stubDb({});
  assert.equal(await resolveReceiptEmail('incore', CHILD, CHILD_EMAIL), CHILD_EMAIL);
});

test('a member with no link and no email stays without one', async () => {
  stubDb({});
  assert.equal(await resolveReceiptEmail('incore', CHILD, ''), undefined);
});

test('family links are read from the brand table only', async () => {
  stubDb({ ...member('forca', PARENT, PARENT_EMAIL) }, { forca: { [CHILD]: PARENT } });
  assert.equal(await resolveReceiptEmail('incore', CHILD, CHILD_EMAIL), CHILD_EMAIL);
});

for (const [name, items] of [
  ['has no email', member('incore', PARENT)],
  ['has a malformed email', member('incore', PARENT, 'not-an-email')],
  ['has no profile', {}],
] as const) {
  test(`a parent who ${name} falls back to the member email and warns`, async () => {
    const warn = mock.method(console, 'warn', () => {});
    stubDb(items, { incore: { [CHILD]: PARENT } });
    assert.equal(await resolveReceiptEmail('incore', CHILD, CHILD_EMAIL), CHILD_EMAIL);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /no valid email/);
  });
}

test('a failed lookup falls back to the member email and never throws', async () => {
  mock.method(console, 'error', () => {});
  ddb.send = (async () => { throw new Error('dynamo down'); }) as typeof ddb.send;
  assert.equal(await resolveReceiptEmail('forca', CHILD, CHILD_EMAIL), CHILD_EMAIL);
});

// ─── What HYP actually receives ────────────────────────────────────────────

const incoreAgreement = {
  PK: 'MEMBER#x', SK: 'AGREEMENT#a', agreementId: 'a', userId: CHILD, productId: 'p', productName: 'Plan',
  token: 'tok', tokenExpiryMonth: 12, tokenExpiryYear: 2030, amountPerCharge: 100,
  paymentsCompleted: 0, totalPayments: 12, status: 'active',
};

test('INCORE recurring charge: linked member, receipt email is the parent', async () => {
  stubDb({ ...member('incore', CHILD, CHILD_EMAIL), ...member('incore', PARENT, PARENT_EMAIL) }, { incore: { [CHILD]: PARENT } });
  const calls = stubHyp(CHARGED);
  await chargeOneAgreement(incoreAgreement);
  assert.equal(calls[0].get('email'), PARENT_EMAIL);
  assert.equal(calls[0].get('SendHesh'), 'True');
});

test('INCORE recurring charge: no link, receipt email is the member', async () => {
  stubDb({ ...member('incore', CHILD, CHILD_EMAIL) });
  const calls = stubHyp(CHARGED);
  await chargeOneAgreement(incoreAgreement);
  assert.equal(calls[0].get('email'), CHILD_EMAIL);
  assert.equal(calls[0].get('SendHesh'), 'True');
});

const forcaAgreement = (payerUid: string) => ({
  PK: 'MEMBER#x', SK: 'FORCAAGREEMENT#a', agreementId: 'a', userId: CHILD, payerUid, payerName: 'Payer',
  subscriptionProductId: 'p', productName: 'Plan', groupId: 'g', groupName: 'Group',
  token: 'tok', tokenExpiryMonth: 12, tokenExpiryYear: 2030, amountPerCharge: 100, status: 'active',
});

test('FORCA recurring charge: an older agreement billing the child sends the receipt to the parent', async () => {
  stubDb({ ...member('forca', CHILD, CHILD_EMAIL), ...member('forca', PARENT, PARENT_EMAIL) }, { forca: { [CHILD]: PARENT } });
  const calls = stubHyp(CHARGED);
  await chargeOneForcaAgreement(forcaAgreement(CHILD));
  assert.equal(calls[0].get('email'), PARENT_EMAIL);
});

test('FORCA recurring charge: a parent payer keeps their own email', async () => {
  stubDb({ ...member('forca', CHILD, CHILD_EMAIL), ...member('forca', PARENT, PARENT_EMAIL) }, { forca: { [CHILD]: PARENT } });
  const calls = stubHyp(CHARGED);
  await chargeOneForcaAgreement(forcaAgreement(PARENT));
  assert.equal(calls[0].get('email'), PARENT_EMAIL);
});

const incoreProduct = {
  'incore|PRODUCT#p|METADATA': { name: 'Plan', type: 'subscription', active: true, price: 100, sessions: 8 },
};

const incoreEvent = (uid: string) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  body: JSON.stringify({ productId: 'p' }),
}) as any;

for (const [name, handler, response] of [
  ['hosted page', hypPaymentPage, SIGNED],
  ['saved card', hypTokenPurchase, CHARGED],
  ['renewal', renewWithToken, CHARGED],
] as const) {
  test(`INCORE ${name}: linked member, receipt email is the parent`, async () => {
    stubDb({ ...incoreProduct, ...member('incore', CHILD, CHILD_EMAIL), ...member('incore', PARENT, PARENT_EMAIL) }, { incore: { [CHILD]: PARENT } });
    const calls = stubHyp(response);
    await handler(incoreEvent(CHILD));
    assert.equal(calls[0].get('email'), PARENT_EMAIL);
  });

  test(`INCORE ${name}: no link, receipt email is the member`, async () => {
    stubDb({ ...incoreProduct, ...member('incore', CHILD, CHILD_EMAIL) });
    const calls = stubHyp(response);
    await handler(incoreEvent(CHILD));
    assert.equal(calls[0].get('email'), CHILD_EMAIL);
  });
}

const merchProduct = {
  'forca|MERCHPRODUCT#m|METADATA': {
    PK: 'MERCHPRODUCT#m', name: 'Shirt', price: 50, active: true,
    variants: [{ id: 'v', label: 'M', stock: 5 }],
  },
};

const merchEvent = (uid: string) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  body: JSON.stringify({ items: [{ merchProductId: 'm', merchVariantId: 'v', quantity: 1 }] }),
}) as any;

for (const [name, handler, response] of [
  ['saved card', merchTokenPurchase, CHARGED],
  ['hosted page', merchPaymentPage, SIGNED],
] as const) {
  test(`FORCA merch by ${name}: a linked child checking out alone, receipt email is the parent`, async () => {
    stubDb({ ...merchProduct, ...member('forca', CHILD, CHILD_EMAIL), ...member('forca', PARENT, PARENT_EMAIL) }, { forca: { [CHILD]: PARENT } });
    const calls = stubHyp(response);
    await handler(merchEvent(CHILD));
    assert.equal(calls[0].get('email'), PARENT_EMAIL);
  });

  test(`FORCA merch by ${name}: no link, receipt email is the member`, async () => {
    stubDb({ ...merchProduct, ...member('forca', CHILD, CHILD_EMAIL) });
    const calls = stubHyp(response);
    await handler(merchEvent(CHILD));
    assert.equal(calls[0].get('email'), CHILD_EMAIL);
  });
}
