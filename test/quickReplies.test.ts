import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'incore';
process.env.FORCA_TABLE_NAME = 'forca';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ddb } = require('../src/lib/dynamo');
const rules = require('../src/lib/quickReplies/rules');
const { adminListQuickReplies, adminSaveQuickReplies, getQuickReplies, useQuickReply } = require('../src/lib/quickReplies/handlers');

const realSend = ddb.send;
afterEach(() => { ddb.send = realSend; });

// ── Rules ───────────────────────────────────────────────────────────────────

test('shortcut: starts with "/", no spaces, unique per brand ignoring case', () => {
  assert.equal(rules.isValidShortcut('/היי'), true);
  assert.equal(rules.isValidShortcut('היי'), false);
  assert.equal(rules.isValidShortcut('/'), false);
  assert.equal(rules.isValidShortcut('/two words'), false);
  assert.equal(rules.isValidShortcut('/a/b'), false);
  const existing = [{ id: '1', shortcut: '/Hi' }, { id: '2', shortcut: '/בדיקה' }];
  assert.equal(rules.isShortcutTaken('/hi', existing), true);
  assert.equal(rules.isShortcutTaken('/hi', existing, '1'), false, 'editing the same reply');
  const v = rules.validateReply({ shortcut: '/בדיקה', title: 't', text: 'x' }, 'incore', existing);
  assert.deepEqual(v, { ok: false, error: 'shortcut_taken' });
  const added = rules.validateReply({ shortcut: 'חדש', title: 't', text: 'x' }, 'incore', existing);
  assert.equal(added.value.shortcut, '/חדש', 'the slash is added when missing');
});

test('INCORE replies are always the admin\'s; FORCA keeps who it\'s for', () => {
  assert.equal(rules.validateReply({ shortcut: '/a', title: 't', text: 'x', visibleTo: 'coach' }, 'incore', []).value.visibleTo, 'admin');
  assert.equal(rules.validateReply({ shortcut: '/a', title: 't', text: 'x', visibleTo: 'coach' }, 'forca', []).value.visibleTo, 'coach');
  assert.equal(rules.validateReply({ shortcut: '/a', title: 't', text: 'x' }, 'forca', []).value.visibleTo, 'both');
});

test('who can use a reply', () => {
  const r = (visibleTo: string, active = true) => ({ visibleTo, active });
  assert.equal(rules.canUseReply(r('coach'), 'coach', 'forca'), true);
  assert.equal(rules.canUseReply(r('both'), 'coach', 'forca'), true);
  assert.equal(rules.canUseReply(r('admin'), 'coach', 'forca'), false, 'coach never sees admin-only replies');
  assert.equal(rules.canUseReply(r('coach'), 'admin', 'forca'), false);
  assert.equal(rules.canUseReply(r('both'), 'admin', 'forca'), true);
  assert.equal(rules.canUseReply(r('both', false), 'admin', 'forca'), false, 'inactive');
  assert.equal(rules.canUseReply(r('admin'), 'coach', 'incore'), false);
  assert.equal(rules.canUseReply(r('admin'), 'admin', 'incore'), true);
});

test('duplicate gets a free shortcut; reorder keeps unlisted ones after', () => {
  assert.equal(rules.duplicateShortcut('/היי', [{ id: '1', shortcut: '/היי' }, { id: '2', shortcut: '/היי-2' }]), '/היי-3');
  assert.deepEqual(
    rules.reorder([{ id: 'a', order: 0 }, { id: 'b', order: 1 }, { id: 'c', order: 2 }], ['c', 'a']),
    [{ id: 'c', order: 0 }, { id: 'a', order: 1 }, { id: 'b', order: 2 }],
  );
});

test('the seeds: shortcuts valid and unique per brand, FORCA visibility as specified', () => {
  for (const seed of [rules.INCORE_SEED, rules.FORCA_SEED]) {
    const shortcuts = seed.map((r: any) => r.shortcut);
    assert.ok(shortcuts.every(rules.isValidShortcut));
    assert.equal(new Set(shortcuts).size, shortcuts.length);
  }
  const vis = Object.fromEntries(rules.FORCA_SEED.map((r: any) => [r.shortcut, r.visibleTo]));
  assert.deepEqual(vis, {
    '/היי': 'both', '/היעדרות': 'coach', '/ציוד': 'coach', '/פציעה': 'coach', '/מזג': 'coach',
    '/טפסים': 'admin', '/עזיבה': 'admin', '/תשלום': 'admin', '/קבוצה': 'admin', '/בדיקה': 'both', '/טופל': 'both',
  });
  assert.equal(rules.INCORE_SEED.length, 10);
  assert.deepEqual(rules.FORCA_MEMBER_SEED, ['לא אגיע לאימון היום', 'אאחר בכמה דקות', 'יש לי כאב/פציעה']);
});

// ── Handlers, against a small in-memory table ───────────────────────────────

function stubTable(profiles: Record<string, any>) {
  const rows = new Map<string, any>(); // `${table}|${SK}` for PK=QUICKREPLY
  const counts = { seedPuts: 0, batchItems: 0 };
  ddb.send = (async (cmd: { constructor: { name: string }; input: any }) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'GetCommand': {
        const { PK, SK } = input.Key;
        if (SK === 'PROFILE') return { Item: profiles[`${input.TableName}|${PK.replace('MEMBER#', '')}`] };
        return { Item: rows.get(`${input.TableName}|${SK}`) };
      }
      case 'PutCommand': {
        const key = `${input.TableName}|${input.Item.SK}`;
        if (input.ConditionExpression && rows.has(key)) {
          const err: any = new Error('cond'); err.name = 'ConditionalCheckFailedException'; throw err;
        }
        if (input.Item.SK === 'SEED') counts.seedPuts += 1;
        rows.set(key, input.Item);
        return {};
      }
      case 'BatchWriteCommand':
        for (const [table, reqs] of Object.entries<any[]>(input.RequestItems)) {
          for (const r of reqs) { rows.set(`${table}|${r.PutRequest.Item.SK}`, r.PutRequest.Item); counts.batchItems += 1; }
        }
        return {};
      case 'QueryCommand':
        return { Items: [...rows.entries()].filter(([k]) => k.startsWith(`${input.TableName}|`)).map(([, v]) => v) };
      case 'UpdateCommand': {
        const key = `${input.TableName}|${input.Key.SK}`;
        const row = rows.get(key);
        if (!row) { const err: any = new Error('cond'); err.name = 'ConditionalCheckFailedException'; throw err; }
        if (input.UpdateExpression.startsWith('ADD usageCount')) row.usageCount = (row.usageCount ?? 0) + 1;
        else row.order = input.ExpressionAttributeValues[':o'];
        return {};
      }
      case 'DeleteCommand':
        rows.delete(`${input.TableName}|${input.Key.SK}`);
        return {};
      default:
        return {};
    }
  }) as any;
  return { rows, counts };
}

const PROFILES = {
  'incore|admin1': { role: 'admin' },
  'forca|coach1': { identity: { role: 'coach', groupIds: ['g1'] } },
  'forca|trainee1': { identity: { name: 'Noa' } },
};
const ev = (uid: string, q: Record<string, string> = {}, body?: unknown) => ({
  requestContext: { authorizer: { jwt: { claims: { sub: uid } } } },
  queryStringParameters: q,
  body: body === undefined ? undefined : JSON.stringify(body),
});
const parse = (r: any) => JSON.parse(r.body);

test('defaults are inserted once per brand', async () => {
  const { counts } = stubTable(PROFILES);
  const first = parse(await adminListQuickReplies(ev('admin1', { brand: 'forca' })));
  assert.equal(first.replies.length, 11);
  assert.equal(first.memberMessages.length, 3);
  await adminListQuickReplies(ev('admin1', { brand: 'forca' }));
  await getQuickReplies(ev('coach1'));
  assert.equal(counts.seedPuts, 1);
  assert.equal(counts.batchItems, 14);
  const incore = parse(await adminListQuickReplies(ev('admin1', { brand: 'incore' })));
  assert.equal(incore.replies.length, 10);
  assert.equal(incore.memberMessages.length, 0);
});

test('a coach gets only replies for coaches; a trainee only the quick messages', async () => {
  stubTable(PROFILES);
  const coach = parse(await getQuickReplies(ev('coach1')));
  const shortcuts = coach.replies.map((r: any) => r.shortcut).sort();
  assert.deepEqual(shortcuts, ['/בדיקה', '/היי', '/היעדרות', '/טופל', '/מזג', '/ציוד', '/פציעה'].sort());
  assert.equal(coach.memberMessages.length, 0);
  const admin = parse(await getQuickReplies(ev('admin1', { brand: 'forca' })));
  assert.ok(!admin.replies.some((r: any) => r.shortcut === '/ציוד'), 'coach-only reply hidden from the admin');
  assert.ok(admin.replies.some((r: any) => r.shortcut === '/טפסים'));
  const trainee = parse(await getQuickReplies(ev('trainee1')));
  assert.equal(trainee.replies.length, 0);
  assert.equal(trainee.memberMessages.length, 3);
});

test('only admins manage; shortcuts stay unique; a coach can\'t count an admin-only reply', async () => {
  stubTable(PROFILES);
  assert.equal((await adminListQuickReplies(ev('coach1', { brand: 'forca' }))).statusCode, 403);
  assert.equal((await adminSaveQuickReplies(ev('coach1', {}, { brand: 'forca', action: 'save', item: {} }))).statusCode, 403);
  const save = (item: any, id?: string) => adminSaveQuickReplies(ev('admin1', {}, { brand: 'forca', action: 'save', id, item }));
  const dup = await save({ shortcut: '/היי', title: 'x', text: 'y' });
  assert.equal(dup.statusCode, 400);
  assert.equal(parse(dup).error, 'shortcut_taken');
  assert.equal((await save({ shortcut: '/חדש', title: 'x', text: 'y', visibleTo: 'admin' })).statusCode, 200);

  const list = parse(await adminListQuickReplies(ev('admin1', { brand: 'forca' }))).replies;
  const adminOnly = list.find((r: any) => r.shortcut === '/טפסים');
  assert.equal((await useQuickReply(ev('coach1', {}, { id: adminOnly.id }))).statusCode, 403);
  const coachOk = list.find((r: any) => r.shortcut === '/ציוד');
  assert.equal((await useQuickReply(ev('coach1', {}, { id: coachOk.id }))).statusCode, 200);
  const after = parse(await adminListQuickReplies(ev('admin1', { brand: 'forca' }))).replies.find((r: any) => r.id === coachOk.id);
  assert.equal(after.usageCount, 1);
});

test('duplicate lands after the original with a free shortcut; reorder and delete', async () => {
  stubTable(PROFILES);
  const list = parse(await adminListQuickReplies(ev('admin1', { brand: 'incore' }))).replies;
  const first = list[0];
  const res = parse(await adminSaveQuickReplies(ev('admin1', {}, { brand: 'incore', action: 'duplicate', id: first.id })));
  const after = parse(await adminListQuickReplies(ev('admin1', { brand: 'incore' }))).replies;
  assert.equal(after[1].id, res.id);
  assert.equal(after[1].shortcut, '/היי-2');
  assert.equal(after.length, 11);

  const ids = after.map((r: any) => r.id).reverse();
  await adminSaveQuickReplies(ev('admin1', {}, { brand: 'incore', action: 'reorder', ids }));
  const reordered = parse(await adminListQuickReplies(ev('admin1', { brand: 'incore' }))).replies.map((r: any) => r.id);
  assert.deepEqual(reordered, ids);

  await adminSaveQuickReplies(ev('admin1', {}, { brand: 'incore', action: 'delete', id: res.id }));
  assert.equal(parse(await adminListQuickReplies(ev('admin1', { brand: 'incore' }))).replies.length, 10);
});
