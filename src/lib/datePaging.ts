import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';

// Date-window paging for history lists ("load the last 2 months, then the
// next 2 months on Load more"). Works on any index whose sort key is
// `<skPrefix><ISO date>#<id>` (e.g. GSI2 ORDER: GSI2SK=<createdAtIso>#<orderId>),
// so a window is a single key-range Query, never a Scan.
//
// The cursor is the sort key the next window must stay strictly below, so a
// row written between page loads can't shift or repeat rows. A window that
// holds more than `maxRawItems` rows is cut short and the cursor points at
// the last row returned, so Load more continues inside the same window.

export const HISTORY_WINDOW_MONTHS = 2;
const DEFAULT_MAX_RAW_ITEMS = 400;
const MAX_WINDOWS_PER_CALL = 60;

/** `months` calendar months before `iso` (clamped day, e.g. Apr 30 → Feb 28). */
export function monthsBefore(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}

export function encodeWindowCursor(upperSk: string): string {
  return Buffer.from(upperSk, 'utf8').toString('base64url');
}

export function decodeWindowCursor(cursor: string, skPrefix: string): string | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!raw.startsWith(skPrefix)) return null;
    if (isNaN(new Date(isoFromSk(raw, skPrefix)).getTime())) return null;
    return raw;
  } catch {
    return null;
  }
}

/** The ISO date at the start of a `<prefix><iso>#<id>` sort key. */
export function isoFromSk(sk: string, skPrefix: string): string {
  return sk.slice(skPrefix.length).split('#')[0];
}

/** Cursor that is just an instant ("load what's older than this"). */
export function encodeIsoCursor(iso: string): string {
  return Buffer.from(iso, 'utf8').toString('base64url');
}

export function decodeIsoCursor(cursor: string): string | null {
  try {
    const iso = Buffer.from(cursor, 'base64url').toString('utf8');
    const d = new Date(iso);
    return isNaN(d.getTime()) || d.toISOString() !== iso ? null : iso;
  } catch {
    return null;
  }
}

// ── In-memory windows ────────────────────────────────────────────────────
// For per-member lists that are small enough to read whole (a few hundred
// rows) but whose stored keys don't sort by the date the list shows (e.g.
// CANCEL#<classId>, or a session date that moves when a session is edited).
// Same contract as queryDateWindow: 2 months per page, empty stretches are
// skipped, and the cursor is "<date>|<id>" of the last row returned.

export interface DatedRow { date: string; id: string }

/** Newest first; ties broken by id so the order is total. */
export function compareDatedDesc(a: DatedRow, b: DatedRow): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function encodeRowCursor(row: DatedRow): string {
  return Buffer.from(`${row.date}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeRowCursor(cursor: string): DatedRow | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const date = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!id || isNaN(new Date(date).getTime())) return null;
    return { date, id };
  } catch {
    return null;
  }
}

/**
 * One 2-month window of `rows` (any order; sorted here) after `cursor`.
 * The first window is anchored on now; a window with no rows jumps to the
 * next older row, so a page is only empty when the history is.
 */
export function windowRows<T extends DatedRow>(
  rows: T[], cursor: DatedRow | null, opts: { months?: number; nowIso?: string } = {},
): DateWindowResult<T> {
  const months = opts.months ?? HISTORY_WINDOW_MONTHS;
  const sorted = [...rows].sort(compareDatedDesc);
  const start = cursor ? sorted.findIndex((r) => compareDatedDesc(cursor, r) < 0) : 0;
  const rest = start < 0 ? [] : sorted.slice(start);
  if (rest.length === 0) {
    return { items: [], nextCursor: null, coveredFrom: cursor?.date ?? opts.nowIso ?? new Date().toISOString() };
  }
  let anchor = cursor ? cursor.date : (opts.nowIso ?? new Date().toISOString());
  let from = monthsBefore(anchor, months);
  // Future-dated rows (e.g. an upcoming booking) always belong to page 1.
  if (rest[0].date < from) { anchor = rest[0].date; from = monthsBefore(anchor, months); }
  let end = rest.findIndex((r) => r.date < from);
  if (end < 0) end = rest.length;
  const items = rest.slice(0, end);
  const more = end < rest.length;
  return { items, nextCursor: more ? encodeRowCursor(items[items.length - 1]) : null, coveredFrom: from };
}

export interface DateWindowQuery<Raw, Row> {
  table: string;
  /** Omit to query the table's own PK/SK. */
  indexName?: string;
  pkName: string;
  pkValue: string;
  skName: string;
  /** Text before the ISO date in the sort key ('' when the key starts with it). */
  skPrefix: string;
  /** From the client; null/undefined = start from now. */
  cursor?: string | null;
  months?: number;
  /** Keep reading older windows until at least this many rows survive `process` (search uses more). */
  minResults?: number;
  maxRawItems?: number;
  /** Map + filter one window's raw items (newest first). */
  process: (items: Raw[]) => Promise<Row[]>;
  /** Clock override for tests. */
  nowIso?: string;
}

export interface DateWindowResult<Row> {
  items: Row[];
  /** Null once nothing older is left. */
  nextCursor: string | null;
  /** Oldest date covered by this response (for "showing since …"). */
  coveredFrom: string;
}

export async function queryDateWindow<Raw extends Record<string, unknown>, Row>(
  q: DateWindowQuery<Raw, Row>,
): Promise<DateWindowResult<Row>> {
  const months = q.months ?? HISTORY_WINDOW_MONTHS;
  const minResults = q.minResults ?? 1;
  const maxRaw = q.maxRawItems ?? DEFAULT_MAX_RAW_ITEMS;
  const nowIso = q.nowIso ?? new Date().toISOString();
  const names = { '#pk': q.pkName, '#sk': q.skName };

  // Exclusive upper bound. '￿' sorts above every real key.
  let upper = q.cursor ? q.cursor : `${q.skPrefix}￿`;
  let anchorIso = q.cursor ? isoFromSk(q.cursor, q.skPrefix) : nowIso;
  const out: Row[] = [];
  let rawRead = 0;
  let coveredFrom = anchorIso;

  for (let w = 0; w < MAX_WINDOWS_PER_CALL; w++) {
    const lower = `${q.skPrefix}${monthsBefore(anchorIso, months)}`;
    coveredFrom = isoFromSk(lower, q.skPrefix);

    // One window, newest first, stopping early if it is too big.
    const windowItems: Raw[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let cutShort = false;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: q.table,
        IndexName: q.indexName,
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lower AND :upper',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ':pk': q.pkValue, ':lower': lower, ':upper': upper },
        ScanIndexForward: false,
        Limit: Math.max(1, maxRaw - rawRead),
        ExclusiveStartKey: lastKey,
      }));
      for (const it of (res.Items ?? []) as Raw[]) {
        if (String(it[q.skName]) < upper) windowItems.push(it);
      }
      rawRead += res.Items?.length ?? 0;
      lastKey = res.LastEvaluatedKey;
      if (lastKey && rawRead >= maxRaw) cutShort = true;
    } while (lastKey && !cutShort);

    out.push(...(await q.process(windowItems)));

    if (cutShort && windowItems.length > 0) {
      const lastSk = String(windowItems[windowItems.length - 1][q.skName]);
      return { items: out, nextCursor: encodeWindowCursor(lastSk), coveredFrom: isoFromSk(lastSk, q.skPrefix) };
    }

    // Anything older than this window?
    const older = await ddb.send(new QueryCommand({
      TableName: q.table,
      IndexName: q.indexName,
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :prefix AND :lower',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ':pk': q.pkValue, ':prefix': q.skPrefix, ':lower': lower },
      ScanIndexForward: false,
      Limit: 1,
    }));
    const olderItem = older.Items?.[0] as Raw | undefined;
    if (!olderItem) return { items: out, nextCursor: null, coveredFrom };
    if (out.length >= minResults || rawRead >= maxRaw) {
      return { items: out, nextCursor: encodeWindowCursor(lower), coveredFrom };
    }

    // Nothing to show yet: jump straight to the next older row instead of
    // walking empty 2-month windows one at a time.
    const olderSk = String(olderItem[q.skName]);
    upper = `${olderSk}\u0000`;
    anchorIso = isoFromSk(olderSk, q.skPrefix);
  }

  return { items: out, nextCursor: encodeWindowCursor(upper), coveredFrom };
}
