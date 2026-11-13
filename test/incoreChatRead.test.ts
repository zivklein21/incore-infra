import test from 'node:test';
import assert from 'node:assert/strict';
import { isIncoreUnreadFor, planReadMarkerBackfill } from '../src/lib/incoreChatRead';

const at = '2026-11-10T10:00:00.000Z';
const before = '2026-11-10T09:00:00.000Z';
const after = '2026-11-10T11:00:00.000Z';

test('unread = the other side wrote last, after my marker', () => {
  const t = { status: 'OPEN' as const, lastSender: 'admin' as const, lastMessageAt: at };
  assert.equal(isIncoreUnreadFor({ ...t, memberReadAt: before }, 'member'), true);
  assert.equal(isIncoreUnreadFor({ ...t, memberReadAt: at }, 'member'), false);
  assert.equal(isIncoreUnreadFor({ ...t, memberReadAt: before }, 'admin'), false, 'she wrote last');
  assert.equal(isIncoreUnreadFor({ ...t, lastSender: 'member', adminReadAt: before }, 'admin'), true);
  assert.equal(isIncoreUnreadFor({ ...t, lastSender: 'member', adminReadAt: after }, 'admin'), false);
  assert.equal(isIncoreUnreadFor({ ...t, status: 'CLOSED', memberReadAt: before }, 'member'), false);
});

test('no marker yet: the old rule (unread until answered)', () => {
  assert.equal(isIncoreUnreadFor({ status: 'OPEN', lastSender: 'admin', lastMessageAt: at }, 'member'), true);
  assert.equal(isIncoreUnreadFor({ status: 'OPEN', lastSender: 'member', lastMessageAt: at }, 'admin'), true);
});

test('backfill marks existing threads read for both sides', () => {
  const set = planReadMarkerBackfill({ lastMessageAt: at, createdAt: before });
  assert.deepEqual(set, { memberReadAt: at, adminReadAt: at });
  const after1 = { status: 'OPEN' as const, lastSender: 'admin' as const, lastMessageAt: at, ...set };
  assert.equal(isIncoreUnreadFor(after1, 'member'), false, 'nobody suddenly has unread');
  assert.equal(isIncoreUnreadFor({ ...after1, lastSender: 'member' }, 'admin'), false);
  assert.equal(planReadMarkerBackfill({ lastMessageAt: at, memberReadAt: at, adminReadAt: at }), null, 'already set');
  assert.deepEqual(planReadMarkerBackfill({ lastMessageAt: at, memberReadAt: before }), { adminReadAt: at }, 'keeps an existing marker');
});
