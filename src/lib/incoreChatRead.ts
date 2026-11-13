import type { SupportInquiryItem } from './entities';

// INCORE chat read markers (app 1.5.2+). Same rule as FORCA's
// (lib/forcaChat/access.ts): a thread is unread for a side when it's open,
// the other side wrote last, and that came after this side's read marker.
// Opening a thread (getInquiryMessages?markRead=1) or answering it moves
// the marker.
//
// Threads from before the markers have none until the one-off backfill
// (scripts/backfillIncoreChatReadMarkers.ts) sets both to lastMessageAt, so
// every existing message counts as read. Until then, no marker falls back
// to the old rule (unread until answered), so nothing changes in between.

export type IncoreChatSide = 'member' | 'admin';

type Thread = Pick<SupportInquiryItem, 'status' | 'lastSender' | 'lastMessageAt' | 'memberReadAt' | 'adminReadAt'>;

export function isIncoreUnreadFor(t: Thread, side: IncoreChatSide): boolean {
  if (t.status !== 'OPEN') return false;
  const last = t.lastSender ?? 'member';
  const at = t.lastMessageAt ?? '';
  if (side === 'member') {
    if (last !== 'admin') return false;
    return !t.memberReadAt || at > t.memberReadAt;
  }
  if (last !== 'member') return false;
  return !t.adminReadAt || at > t.adminReadAt;
}

export const incoreReadField = (side: IncoreChatSide) => (side === 'member' ? 'memberReadAt' : 'adminReadAt');

/** The admin badge (getAllInquiries?openCount=1) as a Scan filter. */
export const INCORE_ADMIN_UNREAD_FILTER =
  'begins_with(PK, :prefix) AND SK = :metadata AND #status = :open AND (attribute_not_exists(lastSender) OR lastSender = :member)'
  + ' AND (attribute_not_exists(adminReadAt) OR adminReadAt < lastMessageAt)';

/** Backfill: both markers at the last message, so everything before the rollout counts as read. */
export function planReadMarkerBackfill(t: Pick<SupportInquiryItem, 'lastMessageAt' | 'createdAt' | 'memberReadAt' | 'adminReadAt'>): Record<string, string> | null {
  const at = t.lastMessageAt ?? t.createdAt;
  if (!at) return null;
  const set: Record<string, string> = {};
  if (!t.memberReadAt) set.memberReadAt = at;
  if (!t.adminReadAt) set.adminReadAt = at;
  return Object.keys(set).length ? set : null;
}
