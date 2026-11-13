import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forcaChatAccess, isUnreadFor, ownerOf, ownerRoleOf, recipientPartition, toThreadRow,
  type ChatCaller, type ChatThread,
} from '../src/lib/forcaChat/access';

const ADMIN: ChatCaller = { uid: 'admin1', isAdmin: true, coachGroupIds: null };
const COACH_A: ChatCaller = { uid: 'coachA', isAdmin: false, coachGroupIds: ['g1'] };
const COACH_B: ChatCaller = { uid: 'coachB', isAdmin: false, coachGroupIds: ['g1', 'g2'] };
const CHILD: ChatCaller = { uid: 'child1', isAdmin: false, coachGroupIds: null };
const PARENT: ChatCaller = { uid: 'parent1', isAdmin: false, coachGroupIds: null };
const STRANGER: ChatCaller = { uid: 'other', isAdmin: false, coachGroupIds: null };

const base = { status: 'OPEN' as const, lastSender: 'member' as const, lastMessageAt: '2026-11-10T10:00:00.000Z' };
const childToCoachA: ChatThread = { ...base, userId: 'child1', ownerUid: 'child1', ownerRole: 'trainee', recipientRole: 'coach', recipientUid: 'coachA', groupId: 'g1' };
const childToAdmin: ChatThread = { ...base, userId: 'child1', ownerUid: 'child1', ownerRole: 'trainee', recipientRole: 'admin' };
const parentToCoachA: ChatThread = { ...base, userId: 'child1', ownerUid: 'parent1', ownerRole: 'parent', recipientRole: 'coach', recipientUid: 'coachA', groupId: 'g1' };
const parentToAdmin: ChatThread = { ...base, userId: 'child1', ownerUid: 'parent1', ownerRole: 'parent', recipientRole: 'admin' };
// Pre-rebuild shapes: no owner fields; a parent's thread has payerUid; coach threads name only a group.
const legacyParentThread: ChatThread = { ...base, userId: 'child1', payerUid: 'parent1', recipientRole: 'admin' };
const legacyGroupThread: ChatThread = { ...base, userId: 'child1', recipientRole: 'coach', groupId: 'g2' };

test('coach reads and answers only threads addressed to her', () => {
  assert.equal(forcaChatAccess(childToCoachA, COACH_A)?.side, 'recipient');
  assert.equal(forcaChatAccess(childToCoachA, COACH_A)?.sender, 'coach');
  assert.equal(forcaChatAccess(childToCoachA, COACH_B), null, 'same group, different coach');
  assert.equal(forcaChatAccess(childToAdmin, COACH_A), null, 'admin thread');
  assert.equal(forcaChatAccess(parentToAdmin, COACH_B), null);
});

test('pre-rebuild group thread: only coaches currently in that group', () => {
  assert.equal(forcaChatAccess(legacyGroupThread, COACH_B)?.side, 'recipient');
  assert.equal(forcaChatAccess(legacyGroupThread, COACH_A), null);
});

test("parent can't read her child's threads, child can't read her parent's", () => {
  assert.equal(forcaChatAccess(childToCoachA, PARENT), null);
  assert.equal(forcaChatAccess(childToAdmin, PARENT), null);
  assert.equal(forcaChatAccess(parentToCoachA, CHILD), null);
  assert.equal(forcaChatAccess(parentToAdmin, CHILD), null);
  assert.equal(forcaChatAccess(legacyParentThread, CHILD), null, 'old parent thread belongs to the parent now');
});

test('owners read and reply to their own threads', () => {
  for (const [t, who] of [[childToCoachA, CHILD], [childToAdmin, CHILD], [parentToCoachA, PARENT], [parentToAdmin, PARENT], [legacyParentThread, PARENT]] as const) {
    const a = forcaChatAccess(t, who);
    assert.equal(a?.side, 'member');
    assert.equal(a?.canReply, true);
    assert.equal(a?.canClose, false);
  }
});

test('admin reads every thread; replies in the app only to her own', () => {
  for (const t of [childToCoachA, childToAdmin, parentToCoachA, parentToAdmin, legacyParentThread, legacyGroupThread]) {
    assert.ok(forcaChatAccess(t, ADMIN), 'admin can read');
  }
  assert.deepEqual(forcaChatAccess(childToAdmin, ADMIN), { side: 'recipient', sender: 'admin', canReply: true, canPost: true, canClose: true });
  const observer = forcaChatAccess(childToCoachA, ADMIN);
  assert.equal(observer?.side, 'observer');
  assert.equal(observer?.canReply, false, 'read-only in the new app');
  assert.equal(observer?.canPost, true, 'server still accepts it for the Backoffice build in the stores');
});

test('strangers get nothing', () => {
  for (const t of [childToCoachA, childToAdmin, parentToCoachA, parentToAdmin, legacyParentThread, legacyGroupThread]) {
    assert.equal(forcaChatAccess(t, STRANGER), null);
  }
});

test('owner falls back for pre-rebuild threads', () => {
  assert.equal(ownerOf(legacyParentThread), 'parent1');
  assert.equal(ownerRoleOf(legacyParentThread), 'parent');
  assert.equal(ownerOf(legacyGroupThread), 'child1');
  assert.equal(ownerRoleOf(legacyGroupThread), 'trainee');
});

test('unread: other side wrote last, after my read marker', () => {
  const t: ChatThread = { ...childToCoachA, lastSender: 'coach', lastMessageAt: '2026-11-10T10:00:00.000Z' };
  assert.equal(isUnreadFor(t, 'member'), true, 'no marker yet');
  assert.equal(isUnreadFor({ ...t, memberReadAt: '2026-11-10T09:00:00.000Z' }, 'member'), true);
  assert.equal(isUnreadFor({ ...t, memberReadAt: '2026-11-10T10:00:00.000Z' }, 'member'), false);
  assert.equal(isUnreadFor(t, 'recipient'), false, 'she wrote last');
  assert.equal(isUnreadFor({ ...t, lastSender: 'member' }, 'recipient'), true);
  assert.equal(isUnreadFor({ ...t, lastSender: 'member', recipientReadAt: '2026-11-10T11:00:00.000Z' }, 'recipient'), false);
  assert.equal(isUnreadFor({ ...t, status: 'CLOSED' }, 'member'), false);
  assert.equal(isUnreadFor({ ...t, lastSender: 'member' }, 'observer'), false, 'admin watching a coach thread never has unread');
});

test('recipient inbox partitions', () => {
  assert.equal(recipientPartition(childToAdmin), 'FORCACHAT#admin');
  assert.equal(recipientPartition(childToCoachA), 'FORCACHAT#coach#coachA');
  assert.equal(recipientPartition(legacyGroupThread), 'FORCACHAT#group#g2');
});

test('row for a pre-rebuild parent thread names the parent and the child', () => {
  const row = toThreadRow({
    PK: 'FORCAINQUIRY#t1', SK: 'METADATA', GSI1PK: '', GSI1SK: '', GSI2PK: '', GSI2SK: '', createdAt: '2026-10-01T00:00:00.000Z',
    ...legacyParentThread, status: 'OPEN', userDisplayName: 'Noa', payerName: 'Dana', childUid: 'child1', childName: 'Noa',
  } as never, forcaChatAccess(legacyParentThread, PARENT)!);
  assert.equal(row.ownerName, 'Dana');
  assert.equal(row.ownerRole, 'parent');
  assert.equal(row.aboutChildName, 'Noa');
  assert.equal(row.canReply, true);
});
