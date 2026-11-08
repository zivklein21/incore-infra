// Run: npm test
// History-list date-window paging (lib/datePaging.ts) against an in-memory
// stand-in for one DynamoDB index partition.
process.env.TABLE_NAME ??= 't';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddb } from '../src/lib/dynamo';
import { pageInquiries } from '../src/lib/inquiryPaging';
import { decodeIsoCursor, decodeRowCursor, decodeWindowCursor, encodeIsoCursor, monthsBefore, queryDateWindow, windowRows } from '../src/lib/datePaging';

type Item = { pk: string; sk: string; n: number };

/** Fakes Query for `#pk = :pk AND #sk BETWEEN :a AND :b`, descending, with Limit/ExclusiveStartKey. */
function fakeIndex(items: Item[]) {
  const sorted = [...items].sort((a, b) => (a.sk < b.sk ? 1 : -1));
  let queries = 0;
  (ddb as unknown as { send: (c: { input: Record<string, any> }) => Promise<unknown> }).send = async (cmd) => {
    queries++;
    const v = cmd.input.ExpressionAttributeValues;
    const lo = v[':lower'] && v[':upper'] ? v[':lower'] : v[':prefix'];
    const hi = v[':lower'] && v[':upper'] ? v[':upper'] : v[':lower'];
    let rows = sorted.filter((i) => i.pk === v[':pk'] && i.sk >= lo && i.sk <= hi);
    const start = cmd.input.ExclusiveStartKey;
    if (start) rows = rows.filter((i) => i.sk < (start as Item).sk);
    const limit = cmd.input.Limit ?? Infinity;
    const page = rows.slice(0, limit);
    return { Items: page, LastEvaluatedKey: rows.length > limit ? page[page.length - 1] : undefined };
  };
  return { queries: () => queries };
}

const NOW = '2026-11-08T12:00:00.000Z';
const at = (iso: string, id: string): Item => ({ pk: 'ORDER', sk: `${iso}#${id}`, n: 0 });
const base = { table: 't', pkName: 'pk', pkValue: 'ORDER', skName: 'sk', skPrefix: '', nowIso: NOW };
const ids = (rows: Item[]) => rows.map((r) => r.sk.split('#')[1]);

test('monthsBefore clamps the day', () => {
  assert.equal(monthsBefore('2026-04-30T10:00:00.000Z', 2), '2026-02-28T10:00:00.000Z');
  assert.equal(monthsBefore('2026-01-15T00:00:00.000Z', 2), '2025-11-15T00:00:00.000Z');
});

test('first call returns only the last 2 months, Load more walks back to the end', async () => {
  fakeIndex([
    at('2026-11-01T00:00:00.000Z', 'a'),
    at('2026-09-20T00:00:00.000Z', 'b'),
    at('2026-08-01T00:00:00.000Z', 'c'),
    at('2026-06-01T00:00:00.000Z', 'd'),
  ]);
  const process = async (rows: Item[]) => rows;
  const p1 = await queryDateWindow({ ...base, process });
  assert.deepEqual(ids(p1.items), ['a', 'b']);
  assert.ok(p1.nextCursor);

  const p2 = await queryDateWindow({ ...base, process, cursor: decodeWindowCursor(p1.nextCursor!, '') });
  assert.deepEqual(ids(p2.items), ['c']);
  const p3 = await queryDateWindow({ ...base, process, cursor: decodeWindowCursor(p2.nextCursor!, '') });
  assert.deepEqual(ids(p3.items), ['d']);
  assert.equal(p3.nextCursor, null);
});

test('empty windows are skipped instead of returning blank pages', async () => {
  fakeIndex([at('2026-11-01T00:00:00.000Z', 'a'), at('2024-01-01T00:00:00.000Z', 'old')]);
  const p1 = await queryDateWindow({ ...base, process: async (r: Item[]) => r });
  const p2 = await queryDateWindow({ ...base, process: async (r: Item[]) => r, cursor: decodeWindowCursor(p1.nextCursor!, '') });
  assert.deepEqual(ids(p2.items), ['old']);
  assert.equal(p2.nextCursor, null);
});

test('a filter that rejects the whole recent window still finds older matches (search)', async () => {
  fakeIndex([at('2026-11-01T00:00:00.000Z', 'x'), at('2025-03-01T00:00:00.000Z', 'hit')]);
  const res = await queryDateWindow({ ...base, process: async (r: Item[]) => r.filter((i) => i.sk.endsWith('hit')) });
  assert.deepEqual(ids(res.items), ['hit']);
  assert.equal(res.nextCursor, null);
});

test('a window bigger than maxRawItems is split with no gaps or repeats', async () => {
  const many = Array.from({ length: 9 }, (_, i) => at(`2026-10-0${i + 1}T00:00:00.000Z`, `r${i}`));
  fakeIndex(many);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const page = await queryDateWindow({ ...base, maxRawItems: 4, process: async (r: Item[]) => r, cursor });
    seen.push(...ids(page.items));
    if (!page.nextCursor) break;
    cursor = decodeWindowCursor(page.nextCursor, '');
  }
  assert.deepEqual(seen, ids([...many].reverse()));
});

test('a row added between loads does not shift the next page', async () => {
  const rows = [at('2026-11-01T00:00:00.000Z', 'a'), at('2026-07-01T00:00:00.000Z', 'b')];
  fakeIndex(rows);
  const p1 = await queryDateWindow({ ...base, process: async (r: Item[]) => r });
  fakeIndex([at('2026-11-07T00:00:00.000Z', 'new'), ...rows]);
  const p2 = await queryDateWindow({ ...base, process: async (r: Item[]) => r, cursor: decodeWindowCursor(p1.nextCursor!, '') });
  assert.deepEqual(ids(p2.items), ['b']);
});

test('a bad cursor is rejected', () => {
  assert.equal(decodeWindowCursor('not-a-cursor', ''), null);
  assert.equal(decodeWindowCursor(Buffer.from('ORDER#x').toString('base64url'), 'EXERCISE#'), null);
});

// ── In-memory windows (windowRows) ───────────────────────────────────────

const r = (id: string, date: string) => ({ id, date });

test('windowRows: last 2 months first, then 2 more per page, no gaps or repeats', () => {
  const rows = [
    r('a', '2026-11-01T00:00:00.000Z'), r('b', '2026-09-20T00:00:00.000Z'),
    r('c', '2026-08-01T00:00:00.000Z'), r('d', '2026-03-01T00:00:00.000Z'),
  ];
  const p1 = windowRows(rows, null, { nowIso: NOW });
  assert.deepEqual(p1.items.map((x) => x.id), ['a', 'b']);
  const p2 = windowRows(rows, decodeRowCursor(p1.nextCursor!), { nowIso: NOW });
  assert.deepEqual(p2.items.map((x) => x.id), ['c']);
  // A long gap is skipped rather than returning an empty page.
  const p3 = windowRows(rows, decodeRowCursor(p2.nextCursor!), { nowIso: NOW });
  assert.deepEqual(p3.items.map((x) => x.id), ['d']);
  assert.equal(p3.nextCursor, null);
});

test('windowRows: nothing recent jumps straight to the newest row', () => {
  const p = windowRows([r('old', '2025-01-01T00:00:00.000Z')], null, { nowIso: NOW });
  assert.deepEqual(p.items.map((x) => x.id), ['old']);
  assert.equal(p.nextCursor, null);
});

test('windowRows: future rows land on page 1, same-date ties stay ordered', () => {
  const rows = [r('x', '2026-10-01T00:00:00.000Z'), r('future', '2026-12-01T00:00:00.000Z'), r('y', '2026-10-01T00:00:00.000Z')];
  const p = windowRows(rows, null, { nowIso: NOW });
  assert.deepEqual(p.items.map((x) => x.id), ['future', 'y', 'x']);
});

test('windowRows: empty history', () => {
  const p = windowRows([], null, { nowIso: NOW });
  assert.deepEqual(p.items, []);
  assert.equal(p.nextCursor, null);
});

test('iso cursor round-trips and rejects junk', () => {
  assert.equal(decodeIsoCursor(encodeIsoCursor(NOW)), NOW);
  assert.equal(decodeIsoCursor(encodeIsoCursor('2026-13-45')), null);
});

test('inquiries: an old open one stays on page 1, closed ones page back by last activity', () => {
  const inq = (id: string, status: string, last: string) => ({ id, status, createdAt: last, lastMessageAt: last });
  const rows = [
    inq('openOld', 'OPEN', '2025-02-01T00:00:00.000Z'),
    inq('closedNew', 'CLOSED', '2026-11-01T00:00:00.000Z'),
    inq('closedOld', 'CLOSED', '2026-01-01T00:00:00.000Z'),
  ];
  const p1 = pageInquiries(rows, undefined, NOW);
  assert.ok(p1.ok);
  if (!p1.ok) return;
  assert.deepEqual(p1.inquiries.map((i) => i.id), ['closedNew', 'openOld']);
  const p2 = pageInquiries(rows, p1.nextCursor!, NOW);
  assert.ok(p2.ok);
  if (!p2.ok) return;
  assert.deepEqual(p2.inquiries.map((i) => i.id), ['closedOld']);
  assert.equal(p2.nextCursor, null);
  assert.equal(pageInquiries(rows, 'junk', NOW).ok, false);
});
