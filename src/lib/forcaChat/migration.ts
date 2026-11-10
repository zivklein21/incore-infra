import type { ForcaSupportInquiryItem } from '../entities';
import { activitySk, ownerOf, ownerRoleOf, recipientPartition } from './access';

// One-off move of pre-rebuild FORCA chat threads onto the new model
// (scripts/migrateForcaChat.ts). Messages are never touched; only the
// thread's METADATA item gets new fields and index keys.
//
//   trainee's thread   -> stays in her inbox, owner = her
//   parent's thread    -> moves to the parent's inbox (GSI1PK), owner = parent;
//                         the child stops seeing it
//   to the admin       -> admin inbox (GSI3 FORCACHAT#admin)
//   to "the coach"     -> the group's coach if the group has exactly one now;
//                         otherwise stays a group thread, seen by every coach
//                         currently in that group
// Read state is left as it was (unread until answered), so nobody gains or
// loses unread dots from the move.

export type MigrationKind =
  | 'already_migrated'
  | 'admin'
  | 'coach_assigned_single'
  | 'coach_group_multiple'
  | 'coach_group_none'
  | 'coach_no_group';

export interface ThreadMigration {
  id: string;
  kind: MigrationKind;
  ownerRole: 'trainee' | 'parent';
  groupId: string | null;
  set: Record<string, unknown>;
}

export function planThreadMigration(
  t: ForcaSupportInquiryItem,
  coachesByGroup: Map<string, { uid: string; name: string }[]>,
): ThreadMigration {
  const id = t.PK.replace('FORCAINQUIRY#', '');
  const ownerRole = ownerRoleOf(t);
  const groupId = t.groupId ?? null;
  if (t.ownerUid && t.GSI3PK !== undefined) return { id, kind: 'already_migrated', ownerRole, groupId, set: {} };
  if (t.ownerUid && t.recipientRole === 'coach' && !t.groupId) return { id, kind: 'already_migrated', ownerRole, groupId, set: {} };

  const owner = ownerOf(t);
  const set: Record<string, unknown> = {
    ownerUid: owner,
    ownerRole,
    ownerName: (ownerRole === 'parent' ? t.payerName : t.userDisplayName) ?? '',
    GSI1PK: `MEMBER#${owner}`,
    GSI2SK: activitySk(t.lastMessageAt ?? t.createdAt, id),
  };
  if (ownerRole === 'parent') {
    set.aboutChildUid = t.childUid ?? t.userId;
    set.aboutChildName = t.childName ?? t.userDisplayName ?? '';
  }

  let kind: MigrationKind;
  let recipientUid: string | undefined;
  if (t.recipientRole === 'admin') {
    kind = 'admin';
  } else if (!t.groupId) {
    kind = 'coach_no_group';
  } else {
    const coaches = coachesByGroup.get(t.groupId) ?? [];
    if (t.recipientUid) {
      kind = 'coach_assigned_single';
      recipientUid = t.recipientUid;
    } else if (coaches.length === 1) {
      kind = 'coach_assigned_single';
      recipientUid = coaches[0].uid;
      set.recipientUid = coaches[0].uid;
      set.recipientName = coaches[0].name;
    } else {
      kind = coaches.length === 0 ? 'coach_group_none' : 'coach_group_multiple';
    }
  }

  const partition = recipientPartition({ recipientRole: t.recipientRole, recipientUid, groupId: t.groupId });
  if (partition) {
    set.GSI3PK = partition;
    set.GSI3SK = set.GSI2SK;
  }
  return { id, kind, ownerRole, groupId, set };
}
