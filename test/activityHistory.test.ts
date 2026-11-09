// Run: npm test
// INCORE Activity tab paging (getActivityHistory ?paged=1): the status filter
// runs over the full history first, then 1 month per page.
process.env.TABLE_NAME ??= 't';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesActivityFilter } from '../src/functions/getActivityHistory';
import { decodeRowCursor, windowRows } from '../src/lib/datePaging';

const NOW = '2026-11-09T12:00:00.000Z';
const item = (id: string, date: string, status: string) => ({ id, date: new Date(date).toISOString(), status });
const page = (rows: ReturnType<typeof item>[], filter: Parameters<typeof matchesActivityFilter>[1], cursor: string | null) =>
  windowRows(rows.filter((r) => matchesActivityFilter(r.status, filter)), cursor ? decodeRowCursor(cursor) : null, { months: 1, nowIso: NOW });

const rows = [
  item('a', '2026-11-02T08:00Z', 'REGISTERED'),
  item('b', '2026-10-20T08:00Z', 'LATE_CANCELLED'),
  item('c', '2026-09-25T08:00Z', 'REGISTERED'),
  item('d', '2026-05-01T08:00Z', 'LATE_CANCELLED'),
];

test('activity: first page is the last month only, Load more goes one month back', () => {
  const p1 = page(rows, 'all', null);
  assert.deepEqual(p1.items.map((r) => r.id), ['a', 'b']);
  assert.ok(p1.nextCursor);
  const p2 = page(rows, 'all', p1.nextCursor);
  assert.deepEqual(p2.items.map((r) => r.id), ['c']);
  const p3 = page(rows, 'all', p2.nextCursor);
  assert.deepEqual(p3.items.map((r) => r.id), ['d'], 'empty months are skipped');
  assert.equal(p3.nextCursor, null);
});

test('activity: a filter covers the full history, not just the loaded month', () => {
  const p1 = page(rows, 'late_cancel', null);
  assert.deepEqual(p1.items.map((r) => r.id), ['b']);
  const p2 = page(rows, 'late_cancel', p1.nextCursor);
  assert.deepEqual(p2.items.map((r) => r.id), ['d']);
  assert.equal(p2.nextCursor, null);
});

test('activity: filter groups match the app chips', () => {
  assert.ok(matchesActivityFilter('ATTENDED', 'arrived'));
  assert.ok(matchesActivityFilter('NO_SHOW', 'late_cancel'));
  assert.ok(matchesActivityFilter('SWAPPED', 'legal_cancel'));
  assert.ok(matchesActivityFilter('ADMIN_CANCELLED', 'admin_cancel'));
  assert.ok(!matchesActivityFilter('ADMIN_CANCELLED', 'late_cancel'));
  assert.ok(matchesActivityFilter('ANYTHING', 'all'));
});
