import test from 'node:test';
import assert from 'node:assert/strict';
import { planThreadMigration } from '../src/lib/forcaChat/migration';
import { forcaChatAccess } from '../src/lib/forcaChat/access';

const T = '2026-10-01T10:00:00.000Z';
const L = '2026-10-05T12:00:00.000Z';
const base = (id: string, extra: Record<string, unknown>) => ({
  PK: `FORCAINQUIRY#${id}`, SK: 'METADATA', GSI1PK: 'MEMBER#child1', GSI1SK: `FORCAINQUIRY#${T}#${id}`,
  GSI2PK: 'FORCAINQUIRY', GSI2SK: `${T}#${id}`, status: 'OPEN', createdAt: T, lastMessageAt: L,
  userId: 'child1', userDisplayName: 'Noa', ...extra,
}) as never;

const coaches = new Map([
  ['solo', [{ uid: 'coachA', name: 'Coach A' }]],
  ['duo', [{ uid: 'coachA', name: 'Coach A' }, { uid: 'coachB', name: 'Coach B' }]],
]);

test("parent's thread moves to the parent; the child loses it", () => {
  const t = base('p1', { recipientRole: 'admin', payerUid: 'parent1', payerName: 'Dana', childUid: 'child1', childName: 'Noa' });
  const plan = planThreadMigration(t, coaches);
  assert.equal(plan.kind, 'admin');
  assert.equal(plan.ownerRole, 'parent');
  assert.deepEqual(plan.set, {
    ownerUid: 'parent1', ownerRole: 'parent', ownerName: 'Dana', GSI1PK: 'MEMBER#parent1',
    GSI2SK: `${L}#p1`, aboutChildUid: 'child1', aboutChildName: 'Noa',
    GSI3PK: 'FORCACHAT#admin', GSI3SK: `${L}#p1`,
  });
  const migrated = { ...(t as object), ...plan.set } as never;
  assert.equal(forcaChatAccess(migrated, { uid: 'child1', isAdmin: false, coachGroupIds: null }), null);
  assert.equal(forcaChatAccess(migrated, { uid: 'parent1', isAdmin: false, coachGroupIds: null })?.side, 'member');
});

test("trainee's thread stays with her", () => {
  const plan = planThreadMigration(base('t1', { recipientRole: 'admin' }), coaches);
  assert.equal(plan.set.ownerUid, 'child1');
  assert.equal(plan.set.GSI1PK, 'MEMBER#child1');
  assert.equal(plan.set.ownerRole, 'trainee');
});

test('coach thread: single coach is assigned, several keep it a group thread', () => {
  const solo = planThreadMigration(base('c1', { recipientRole: 'coach', groupId: 'solo' }), coaches);
  assert.equal(solo.kind, 'coach_assigned_single');
  assert.equal(solo.set.recipientUid, 'coachA');
  assert.equal(solo.set.GSI3PK, 'FORCACHAT#coach#coachA');

  const duo = planThreadMigration(base('c2', { recipientRole: 'coach', groupId: 'duo' }), coaches);
  assert.equal(duo.kind, 'coach_group_multiple');
  assert.equal(duo.set.recipientUid, undefined);
  assert.equal(duo.set.GSI3PK, 'FORCACHAT#group#duo');

  assert.equal(planThreadMigration(base('c3', { recipientRole: 'coach', groupId: 'empty' }), coaches).kind, 'coach_group_none');
});

test('read state is left alone', () => {
  const plan = planThreadMigration(base('r1', { recipientRole: 'admin', lastSender: 'admin' }), coaches);
  assert.ok(!('memberReadAt' in plan.set) && !('recipientReadAt' in plan.set));
});

test('migrated or new threads are skipped', () => {
  const plan = planThreadMigration(base('n1', { recipientRole: 'admin', ownerUid: 'child1', GSI3PK: 'FORCACHAT#admin' }), coaches);
  assert.equal(plan.kind, 'already_migrated');
  assert.deepEqual(plan.set, {});
});
