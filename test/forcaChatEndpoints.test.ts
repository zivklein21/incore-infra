import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const { handler: getMessages } = require('../src/functions/getForcaInquiryMessages');
const { handler: sendMessage } = require('../src/functions/sendForcaSupportMessage');
const { handler: getMine } = require('../src/functions/getMyForcaInquiries');
const { handler: getCoach } = require('../src/functions/getCoachForcaInquiries');
const { handler: getAll } = require('../src/functions/getAllForcaInquiries');
const { handler: create } = require('../src/functions/createForcaSupportInquiry');
const { handler: close } = require('../src/functions/closeForcaSupportInquiry');

const realSend = ddb.send;
afterEach(() => { ddb.send = realSend; });

const T = '2026-11-10T10:00:00.000Z';
const thread = (id: string, extra: Record<string, unknown>) => ({
  PK: `FORCAINQUIRY#${id}`, SK: 'METADATA', GSI2PK: 'FORCAINQUIRY', GSI2SK: `${T}#${id}`,
  status: 'OPEN', subject: 's', lastMessage: 'hi', lastMessageAt: T, lastSender: 'member', createdAt: T, ...extra,
});
const THREADS = [
  thread('childToCoachA', { userId: 'child1', ownerUid: 'child1', ownerRole: 'trainee', recipientRole: 'coach', recipientUid: 'coachA', groupId: 'g1', GSI1PK: 'MEMBER#child1', GSI3PK: 'FORCACHAT#coach#coachA', GSI3SK: `${T}#childToCoachA` }),
  thread('childToAdmin', { userId: 'child1', ownerUid: 'child1', ownerRole: 'trainee', recipientRole: 'admin', GSI1PK: 'MEMBER#child1', GSI3PK: 'FORCACHAT#admin', GSI3SK: `${T}#childToAdmin` }),
  thread('parentToCoachB', { userId: 'child1', ownerUid: 'parent1', ownerRole: 'parent', aboutChildUid: 'child1', recipientRole: 'coach', recipientUid: 'coachB', groupId: 'g1', GSI1PK: 'MEMBER#parent1', GSI3PK: 'FORCACHAT#coach#coachB', GSI3SK: `${T}#parentToCoachB` }),
  // Pre-rebuild parent thread, not migrated yet: still filed under the child.
  thread('legacyParent', { userId: 'child1', payerUid: 'parent1', childUid: 'child1', recipientRole: 'admin', GSI1PK: 'MEMBER#child1' }),
  // Pre-rebuild group thread for g1.
  thread('legacyGroup', { userId: 'child2', recipientRole: 'coach', groupId: 'g1', GSI1PK: 'MEMBER#child2', GSI3PK: 'FORCACHAT#group#g1', GSI3SK: `${T}#legacyGroup` }),
];

const PROFILES: Record<string, any> = {
  'incore|admin1': { role: 'admin' },
  'forca|coachA': { PK: 'MEMBER#coachA', identity: { role: 'coach', name: 'Coach A', groupIds: ['g1'] } },
  'forca|coachB': { PK: 'MEMBER#coachB', identity: { role: 'coach', name: 'Coach B', groupIds: ['g1'] } },
  'forca|coachC': { PK: 'MEMBER#coachC', identity: { role: 'coach', name: 'Coach C', groupIds: ['g2'] } },
  'forca|child1': { PK: 'MEMBER#child1', identity: { name: 'Noa', groupId: 'g1' } },
  'forca|parent1': { PK: 'MEMBER#parent1', identity: { name: 'Dana', accountType: 'parent_only' } },
};

function stub() {
  const writes: any[] = [];
  const queries: any[] = [];
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'GetCommand': {
        const { PK, SK } = input.Key;
        if (SK === 'PROFILE') return { Item: PROFILES[`${input.TableName}|${PK.replace('MEMBER#', '')}`] };
        if (SK === 'METADATA' && PK.startsWith('FORCAINQUIRY#')) return { Item: THREADS.find((t) => t.PK === PK) };
        if (SK.startsWith('FAMILY#')) return { Item: PK === 'MEMBER#parent1' && SK === 'FAMILY#child1' ? { parentUid: 'parent1' } : undefined };
        if (PK.startsWith('GROUP#')) return { Item: { name: 'Group 1' } };
        return {};
      }
      case 'QueryCommand': {
        queries.push(input);
        const pk = input.ExpressionAttributeValues[':pk'];
        if (!input.IndexName) return { Items: [] };
        const attr = input.IndexName === 'GSI1' ? 'GSI1PK' : `${input.IndexName}PK`;
        const items = THREADS.filter((t: any) => t[attr] === pk);
        return input.Select === 'COUNT' ? { Count: items.length } : { Items: items };
      }
      case 'ScanCommand':
        return { Items: Object.entries(PROFILES).filter(([k, p]) => k.startsWith('forca|') && p.identity?.role === 'coach').map(([, p]) => ({ ...p, SK: 'PROFILE' })) };
      default:
        writes.push({ type: cmd.constructor.name, input });
        return {};
    }
  }) as any;
  return { writes, queries };
}

const ev = (uid: string, q: Record<string, string> = {}, body?: unknown) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  queryStringParameters: q,
  body: body === undefined ? undefined : JSON.stringify(body),
});

const read = (uid: string, id: string, q: Record<string, string> = {}) => getMessages(ev(uid, { inquiryId: id, ...q }));
const post = (uid: string, id: string) => sendMessage(ev(uid, {}, { inquiryId: id, text: 'hello' }));

test("coach can't read or answer another coach's thread, or the admin's", async () => {
  stub();
  assert.equal((await read('coachB', 'childToCoachA')).statusCode, 403);
  assert.equal((await read('coachA', 'childToAdmin')).statusCode, 403);
  assert.equal((await read('coachC', 'legacyGroup')).statusCode, 403, 'old group thread of a group she is not in');
  assert.equal((await post('coachB', 'childToCoachA')).statusCode, 403);
  assert.equal((await read('coachA', 'childToCoachA')).statusCode, 200);
  assert.equal((await read('coachA', 'legacyGroup')).statusCode, 200, 'old group thread of her group');
});

test("parent can't read her child's threads, and the child can't read the parent's", async () => {
  stub();
  assert.equal((await read('parent1', 'childToCoachA')).statusCode, 403);
  assert.equal((await read('parent1', 'childToAdmin')).statusCode, 403);
  assert.equal((await post('parent1', 'childToAdmin')).statusCode, 403);
  assert.equal((await read('child1', 'parentToCoachB')).statusCode, 403);
  assert.equal((await read('child1', 'legacyParent')).statusCode, 403);
  assert.equal((await post('child1', 'legacyParent')).statusCode, 403);
  assert.equal((await read('parent1', 'legacyParent')).statusCode, 200);
});

test('admin can read every thread; reading a coach thread leaves its read state alone', async () => {
  const { writes } = stub();
  for (const t of THREADS) {
    const res = await read('admin1', t.PK.replace('FORCAINQUIRY#', ''), { markRead: '1' });
    assert.equal(res.statusCode, 200, t.PK);
  }
  const marked = writes.filter((w) => w.type === 'UpdateCommand').map((w) => w.input.Key.PK);
  assert.deepEqual(marked.sort(), ['FORCAINQUIRY#childToAdmin', 'FORCAINQUIRY#legacyParent'], 'only her own threads get her read marker');
  const row = JSON.parse((await read('admin1', 'childToCoachA')).body).thread;
  assert.equal(row.canReply, false, 'coach threads are read-only in the app');
});

test("the admin can still post in a coach thread (Backoffice build in the stores)", async () => {
  const { writes } = stub();
  assert.equal((await post('admin1', 'childToCoachA')).statusCode, 200);
  const msg = writes.find((w) => w.type === 'PutCommand');
  assert.equal(msg.input.Item.sender, 'admin');
});

test('marking read sets the right side', async () => {
  const { writes } = stub();
  await read('coachA', 'childToCoachA', { markRead: '1' });
  await read('child1', 'childToCoachA', { markRead: '1' });
  const fields = writes.filter((w) => w.type === 'UpdateCommand').map((w) => w.input.ExpressionAttributeNames['#f']);
  assert.deepEqual(fields, ['recipientReadAt', 'memberReadAt']);
});

test("a member's list holds only her own threads", async () => {
  stub();
  const child = JSON.parse((await getMine(ev('child1'))).body).inquiries.map((r: any) => r.id).sort();
  assert.deepEqual(child, ['childToAdmin', 'childToCoachA'], "the parent's old thread filed under her is left out");
  const parent = JSON.parse((await getMine(ev('parent1', { childUid: 'child1' }))).body).inquiries.map((r: any) => r.id);
  assert.deepEqual(parent, ['parentToCoachB'], "a store build's child switcher gets the parent's own threads, not the child's");
  assert.equal((await getMine(ev('coachA', { childUid: 'child1' }))).statusCode, 403, 'not her child');
});

test("a coach's inbox reads only her partitions", async () => {
  const { queries } = stub();
  const rows = JSON.parse((await getCoach(ev('coachA', { paged: '1' }))).body).inquiries.map((r: any) => r.id).sort();
  assert.deepEqual(rows, ['childToCoachA', 'legacyGroup']);
  assert.deepEqual(queries.map((q) => q.ExpressionAttributeValues[':pk']).sort(), ['FORCACHAT#coach#coachA', 'FORCACHAT#group#g1']);
  assert.ok(queries.every((q) => q.IndexName === 'GSI3'), 'no scan');
  assert.equal((await getCoach(ev('child1'))).statusCode, 403);
});

test('admin inbox filters and badge', async () => {
  stub();
  const ids = async (q: Record<string, string>) => JSON.parse((await getAll(ev('admin1', { paged: '1', ...q }))).body).inquiries.map((r: any) => r.id).sort();
  assert.deepEqual(await ids({ box: 'mine' }), ['childToAdmin']);
  assert.deepEqual(await ids({ box: 'coaches', coachUid: 'coachB' }), ['legacyGroup', 'parentToCoachB']);
  assert.equal((await ids({ box: 'all' })).length, THREADS.length);
  assert.equal(JSON.parse((await getAll(ev('admin1', { unreadCount: '1' }))).body).unreadCount, 1, 'counts only threads addressed to her');
  assert.equal((await getAll(ev('coachA'))).statusCode, 403);
});

test('only trainees and parents start threads; a parent\'s thread lands in her own inbox', async () => {
  const { writes } = stub();
  const body = { subject: 's', message: 'hello there', recipientRole: 'coach', recipientUid: 'coachA', childUid: 'child1' };
  assert.equal((await create(ev('coachA', {}, body))).statusCode, 403);
  assert.equal((await create(ev('admin1', {}, body))).statusCode, 403);
  assert.equal((await create(ev('parent1', {}, { ...body, recipientUid: 'coachC' }))).statusCode, 400, 'coach not in the child\'s group');
  assert.equal((await create(ev('parent1', {}, { ...body, childUid: undefined }))).statusCode, 400, 'parent must say which child');
  assert.equal((await create(ev('parent1', {}, body))).statusCode, 200);
  const item = writes.find((w) => w.type === 'TransactWriteCommand').input.TransactItems[0].Put.Item;
  assert.equal(item.GSI1PK, 'MEMBER#parent1');
  assert.equal(item.ownerRole, 'parent');
  assert.equal(item.aboutChildUid, 'child1');
  assert.equal(item.GSI3PK, 'FORCACHAT#coach#coachA');
  const auto = writes.find((w) => w.type === 'TransactWriteCommand').input.TransactItems[2]?.Put.Item;
  assert.equal(auto?.isAutoReply, true, "the coach auto-reply is added by the server");
  assert.equal(auto?.sender, 'coach');
  assert.equal(item.lastSender, 'member', 'still unread for the coach');
  assert.equal(item.memberReadAt, item.lastMessageAt, 'already read by her');
});

test('a store build without recipientUid: single coach gets it, several keep it a group thread', async () => {
  const { writes } = stub();
  await create(ev('parent1', {}, { subject: 's', message: 'hello there', recipientRole: 'coach', childUid: 'child1' }));
  const item = writes.find((w) => w.type === 'TransactWriteCommand').input.TransactItems[0].Put.Item;
  assert.equal(item.recipientUid, undefined, 'g1 has two coaches');
  assert.equal(item.GSI3PK, 'FORCACHAT#group#g1');
});

test('only the recipient (or the admin) closes a thread', async () => {
  stub();
  assert.equal((await close(ev('child1', {}, { inquiryId: 'childToCoachA' }))).statusCode, 403);
  assert.equal((await close(ev('coachB', {}, { inquiryId: 'childToCoachA' }))).statusCode, 403);
  assert.equal((await close(ev('coachA', {}, { inquiryId: 'childToCoachA' }))).statusCode, 200);
});
