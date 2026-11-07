import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { handler: setAlert } = require('../src/functions/adminSetMemberAlert');
const { handler: setPayment } = require('../src/functions/adminSetForceShowPaymentButton');
const { handler: updatePersonal } = require('../src/functions/adminUpdateMemberPersonal');
const { handler: familyInfo } = require('../src/functions/adminGetMemberFamilyInfo');

const realSend = ddb.send;
afterEach(() => { ddb.send = realSend; });

const ADMIN = { 'incore|MEMBER#admin1|PROFILE': { role: 'admin' } };

function stubTable(items: Record<string, unknown>, parentLinks: Record<string, { table: string; parentUid: string }> = {}) {
  const updates: any[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'GetCommand':
        return { Item: items[`${input.TableName}|${input.Key.PK}|${input.Key.SK}`] };
      case 'QueryCommand': {
        if (input.IndexName !== 'GSI1') return { Items: [] };
        const link = parentLinks[input.ExpressionAttributeValues[':pk'].replace('MEMBER#', '')];
        return { Items: link && link.table === input.TableName ? [{ parentUid: link.parentUid }] : [] };
      }
      case 'UpdateCommand':
        updates.push(input);
        return {};
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  }) as typeof ddb.send;
  return updates;
}

const event = (extra: Record<string, unknown>) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: 'admin1' } } } },
  ...extra,
}) as any;
const post = (body: unknown) => event({ body: JSON.stringify(body) });

const personal = { memberId: 'm1', firstName: 'A', lastName: 'B', phone: '050', email: 'a@b.c', role: 'member' };
const writes: [string, (e: any) => Promise<any>, Record<string, unknown>][] = [
  ['alert', setAlert, { memberId: 'm1', message: 'hi' }],
  ['payment button', setPayment, { memberId: 'm1', enabled: true }],
  ['personal details', updatePersonal, personal],
];

for (const [name, handler, body] of writes) {
  test(`${name}: a FORCA member is written in the FORCA table`, async () => {
    const updates = stubTable({ ...ADMIN, 'forca|MEMBER#m1|PROFILE': { identity: {} } });
    assert.equal((await handler(post({ ...body, brand: 'forca' }))).statusCode, 200);
    assert.equal(updates[0].TableName, 'forca');
  });

  test(`${name}: an old app build with no brand still finds a FORCA member`, async () => {
    const updates = stubTable({ ...ADMIN, 'forca|MEMBER#m1|PROFILE': { identity: {} } });
    assert.equal((await handler(post(body))).statusCode, 200);
    assert.equal(updates[0].TableName, 'forca');
  });

  test(`${name}: with a profile in both tables, the admin's brand decides`, async () => {
    const both = { ...ADMIN, 'forca|MEMBER#m1|PROFILE': { identity: {} }, 'incore|MEMBER#m1|PROFILE': { identity: {} } };
    const updates = stubTable(both);
    await handler(post({ ...body, brand: 'forca' }));
    await handler(post({ ...body, brand: 'incore' }));
    assert.deepEqual(updates.map((u) => u.TableName), ['forca', 'incore']);
  });

  test(`${name}: an unknown member is a 404`, async () => {
    const updates = stubTable(ADMIN);
    assert.equal((await handler(post(body))).statusCode, 404);
    assert.equal((await handler(post({ ...body, brand: 'forca' }))).statusCode, 404);
    assert.equal(updates.length, 0);
  });
}

test('family info finds a FORCA parent', async () => {
  stubTable({
    ...ADMIN,
    'forca|MEMBER#m1|PROFILE': { identity: { name: 'Kid' } },
    'forca|MEMBER#p1|PROFILE': { identity: { name: 'Parent', phone: '0502222222' } },
  }, { m1: { table: 'forca', parentUid: 'p1' } });
  const res = await familyInfo(event({ queryStringParameters: { memberId: 'm1', brand: 'forca' } }));
  assert.deepEqual(JSON.parse(res.body).parent, { uid: 'p1', name: 'Parent', phone: '0502222222' });
});

test('family info for an unknown member is empty', async () => {
  stubTable(ADMIN);
  const res = await familyInfo(event({ queryStringParameters: { memberId: 'ghost' } }));
  assert.deepEqual(JSON.parse(res.body), { parent: null, children: [] });
});

test('only an admin can use these', async () => {
  stubTable({ 'forca|MEMBER#m1|PROFILE': { identity: {} } });
  const asMember = (body: unknown) => ({ ...post(body), requestContext: { authorizer: { jwt: { claims: { sub: 'm1' } } } } });
  for (const [name, handler, body] of writes) {
    assert.equal((await handler(asMember({ ...body, brand: 'forca' }))).statusCode, 403, name);
  }
});
