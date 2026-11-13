import { decodeRowCursor, windowRows } from './datePaging';

// Paging rule for support inquiry lists (?paged=1): every OPEN inquiry is on
// page 1, so an open conversation is never hidden behind Load more and the
// unread badge stays complete; CLOSED ones page back in 2-month windows by
// last activity (lastMessageAt, else createdAt).

interface InquiryRowBase {
  id: string;
  status: string;
  createdAt: string | null;
  lastMessageAt: string | null;
}

const activityOf = (r: InquiryRowBase) => r.lastMessageAt ?? r.createdAt ?? '1970-01-01T00:00:00.000Z';

/** Latest activity first. */
export function sortInquiries<T extends InquiryRowBase>(rows: T[]): T[] {
  return [...rows].sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
}

export type InquiryPage<T> =
  | { ok: true; inquiries: T[]; nextCursor: string | null; coveredFrom: string }
  | { ok: false };

export function pageInquiries<T extends InquiryRowBase>(rows: T[], cursorRaw: string | undefined, nowIso?: string): InquiryPage<T> {
  const cursor = cursorRaw ? decodeRowCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return { ok: false };
  const open = cursor ? [] : rows.filter((r) => r.status === 'OPEN');
  const closed = rows.filter((r) => r.status !== 'OPEN').map((r) => ({ row: r, date: activityOf(r), id: r.id }));
  const page = windowRows(closed, cursor, { nowIso });
  return {
    ok: true,
    inquiries: sortInquiries([...open, ...page.items.map((x) => x.row)]),
    nextCursor: page.nextCursor,
    coveredFrom: page.coveredFrom,
  };
}
