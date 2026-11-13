import type { ForcaSupportInquiryItem } from '../entities';

// FORCA chat rules, in one place, with no I/O so they can be unit tested.
// Every FORCA chat endpoint asks forcaChatAccess() who the caller is to a
// thread; nothing else decides visibility.
//
//   owner (trainee or parent who started it) — read, reply
//   recipient (the admin inbox, or the one coach it's addressed to) — read, reply, close
//   admin on a coach thread — read only in the app. The server still lets her
//     post and close, because the Backoffice build in the stores does that.
//   anyone else (her parent, her child, another coach) — nothing.

export type ChatThread = Pick<ForcaSupportInquiryItem,
  'userId' | 'recipientRole' | 'groupId' | 'status' | 'lastSender' | 'lastMessageAt'
  | 'ownerUid' | 'ownerRole' | 'payerUid' | 'recipientUid' | 'memberReadAt' | 'recipientReadAt'>;

export interface ChatCaller {
  uid: string;
  isAdmin: boolean;
  /** A coach's assigned groups; null when the caller isn't a coach. */
  coachGroupIds: string[] | null;
}

/** member = the thread's owner; recipient = whoever it's addressed to; observer = admin looking at a coach thread. */
export type ChatSide = 'member' | 'recipient' | 'observer';

export interface ChatAccess {
  side: ChatSide;
  /** The `sender` written on a message this caller posts. */
  sender: 'member' | 'admin' | 'coach';
  /** What the app offers: a reply box (and, for the recipient, Close). */
  canReply: boolean;
  /** What the server accepts. Wider than canReply only for the admin on a coach thread. */
  canPost: boolean;
  canClose: boolean;
}

/** The account that started the thread. Pre-rebuild threads: the parent who sent it, else the trainee. */
export function ownerOf(t: Pick<ChatThread, 'ownerUid' | 'payerUid' | 'userId'>): string {
  return t.ownerUid ?? t.payerUid ?? t.userId;
}

export function ownerRoleOf(t: Pick<ChatThread, 'ownerRole' | 'payerUid'>): 'trainee' | 'parent' {
  return t.ownerRole ?? (t.payerUid ? 'parent' : 'trainee');
}

/** A pre-rebuild coach thread: addressed to a group, not one coach. */
export function isGroupThread(t: Pick<ChatThread, 'recipientRole' | 'recipientUid'>): boolean {
  return t.recipientRole === 'coach' && !t.recipientUid;
}

export function forcaChatAccess(t: ChatThread, caller: ChatCaller): ChatAccess | null {
  if (ownerOf(t) === caller.uid) {
    return { side: 'member', sender: 'member', canReply: true, canPost: true, canClose: false };
  }
  if (caller.isAdmin) {
    return t.recipientRole === 'admin'
      ? { side: 'recipient', sender: 'admin', canReply: true, canPost: true, canClose: true }
      : { side: 'observer', sender: 'admin', canReply: false, canPost: true, canClose: true };
  }
  if (caller.coachGroupIds && t.recipientRole === 'coach') {
    const addressedToHer = t.recipientUid
      ? t.recipientUid === caller.uid
      : !!t.groupId && caller.coachGroupIds.includes(t.groupId);
    if (addressedToHer) return { side: 'recipient', sender: 'coach', canReply: true, canPost: true, canClose: true };
  }
  return null;
}

/**
 * Unread for this side: the thread is open, the other side sent the last
 * message, and it came after this side's read marker. Without a marker
 * (threads from before the rebuild, never opened since) it falls back to the
 * old rule: unread until answered.
 */
export function isUnreadFor(t: ChatThread, side: ChatSide): boolean {
  if (t.status !== 'OPEN' || side === 'observer') return false;
  const last = t.lastSender ?? 'member';
  const at = t.lastMessageAt ?? '';
  if (side === 'member') {
    if (last === 'member') return false;
    return !t.memberReadAt || at > t.memberReadAt;
  }
  if (last !== 'member') return false;
  return !t.recipientReadAt || at > t.recipientReadAt;
}

/** The read marker field this side sets when it opens or answers the thread. */
export function readMarkerField(side: ChatSide): 'memberReadAt' | 'recipientReadAt' | null {
  if (side === 'member') return 'memberReadAt';
  if (side === 'recipient') return 'recipientReadAt';
  return null;
}

// The same unread rules as DynamoDB filters, for badge counts (Select COUNT).
export const RECIPIENT_UNREAD_FILTER = {
  expr: '#status = :open AND (attribute_not_exists(lastSender) OR lastSender = :member) AND (attribute_not_exists(recipientReadAt) OR recipientReadAt < lastMessageAt)',
  names: { '#status': 'status' },
  values: { ':open': 'OPEN', ':member': 'member' },
};

/** Member side, over her own GSI1 partition. Leaves out pre-rebuild parent threads still filed under the child. */
export function memberUnreadFilter(uid: string) {
  return {
    expr: '#status = :open AND lastSender IN (:admin, :coach) AND (attribute_not_exists(memberReadAt) OR memberReadAt < lastMessageAt)'
      + ' AND (ownerUid = :me OR (attribute_not_exists(ownerUid) AND attribute_not_exists(payerUid)))',
    names: { '#status': 'status' },
    values: { ':open': 'OPEN', ':admin': 'admin', ':coach': 'coach', ':me': uid },
  };
}

// ── Index keys ──────────────────────────────────────────────────────────────

/** The recipient's inbox partition (GSI3PK). */
export function recipientPartition(t: Pick<ChatThread, 'recipientRole' | 'recipientUid' | 'groupId'>): string | null {
  if (t.recipientRole === 'admin') return 'FORCACHAT#admin';
  if (t.recipientUid) return `FORCACHAT#coach#${t.recipientUid}`;
  if (t.groupId) return `FORCACHAT#group#${t.groupId}`;
  return null;
}

export const coachPartition = (coachUid: string) => `FORCACHAT#coach#${coachUid}`;
export const groupPartition = (groupId: string) => `FORCACHAT#group#${groupId}`;
export const ADMIN_PARTITION = 'FORCACHAT#admin';

/** Sort key for "newest activity first" (GSI2SK / GSI3SK). */
export const activitySk = (lastMessageAt: string, id: string) => `${lastMessageAt}#${id}`;

/** New message keys sort by time, so a thread's messages can be paged by key. */
export const messageSk = (createdAtIso: string, messageId: string) => `MESSAGE#${createdAtIso}#${messageId}`;

// ── Rows sent to the app ────────────────────────────────────────────────────

export interface ChatThreadRow {
  id: string;
  subject: string;
  status: 'OPEN' | 'CLOSED';
  ownerUid: string;
  ownerRole: 'trainee' | 'parent';
  ownerName: string;
  aboutChildUid: string | null;
  aboutChildName: string | null;
  recipientRole: 'admin' | 'coach';
  recipientUid: string | null;
  recipientName: string | null;
  groupName: string | null;
  lastMessage: string;
  lastSender: 'member' | 'admin' | 'coach';
  createdAt: string | null;
  lastMessageAt: string | null;
  unread: boolean;
  canReply: boolean;
  // Field names the app versions in the stores read.
  userId: string;
  userDisplayName: string;
  userEmail: string;
}

export function toThreadRow(t: ForcaSupportInquiryItem, access: ChatAccess): ChatThreadRow {
  const role = ownerRoleOf(t);
  const aboutChildUid = t.aboutChildUid ?? (role === 'parent' ? t.childUid ?? t.userId : undefined);
  return {
    id: t.PK.replace('FORCAINQUIRY#', ''),
    subject: t.subject ?? '',
    status: t.status,
    ownerUid: ownerOf(t),
    ownerRole: role,
    ownerName: t.ownerName ?? (role === 'parent' ? t.payerName : t.userDisplayName) ?? '',
    aboutChildUid: aboutChildUid ?? null,
    aboutChildName: aboutChildUid ? (t.aboutChildName ?? t.childName ?? t.userDisplayName ?? null) : null,
    recipientRole: t.recipientRole,
    recipientUid: t.recipientUid ?? null,
    recipientName: t.recipientName ?? null,
    groupName: t.groupName ?? null,
    lastMessage: t.lastMessage ?? '',
    lastSender: t.lastSender ?? 'member',
    createdAt: t.createdAt ?? null,
    lastMessageAt: t.lastMessageAt ?? null,
    unread: isUnreadFor(t, access.side),
    canReply: access.canReply,
    userId: t.userId ?? '',
    userDisplayName: t.userDisplayName ?? '',
    userEmail: t.userEmail ?? '',
  };
}
