import test from 'node:test';
import assert from 'node:assert/strict';
import { endOfMonth, firstOfNextMonth, israelDayStart, israelDateStr, monthKey } from '../src/lib/entities';

const iso = (d: Date) => d.toISOString();

test('a mid-month purchase ends on the last day of the month, Israel time', () => {
  const end = endOfMonth(new Date('2026-11-06T11:09:00Z'));
  assert.equal(iso(end), '2026-11-30T21:59:59.999Z'); // winter, UTC+2
  assert.equal(israelDateStr(end), '2026-11-30');
});

test('the same holds in summer time', () => {
  const end = endOfMonth(new Date('2026-07-10T09:00:00Z'));
  assert.equal(iso(end), '2026-07-31T20:59:59.999Z'); // summer, UTC+3
  assert.equal(israelDateStr(end), '2026-07-31');
});

test('the next charge is midnight on the 1st in Israel', () => {
  const next = firstOfNextMonth(new Date('2026-11-06T11:09:00Z'));
  assert.equal(iso(next), '2026-11-30T22:00:00.000Z');
  assert.equal(israelDateStr(next), '2026-12-01');
});

test('the charge is due by the 03:30 run on the 1st, not the day before', () => {
  const next = firstOfNextMonth(new Date('2026-11-06T11:09:00Z')).getTime();
  assert.ok(next <= new Date('2026-12-01T01:30:00Z').getTime());
  assert.ok(next > new Date('2026-11-30T01:30:00Z').getTime());
});

test('paying just after midnight on the 1st belongs to the new month', () => {
  const now = new Date('2026-11-30T22:30:00Z'); // Dec 1, 00:30 in Israel
  assert.equal(monthKey(now), '2026-12');
  assert.equal(israelDateStr(endOfMonth(now)), '2026-12-31');
  assert.equal(israelDateStr(firstOfNextMonth(now)), '2027-01-01');
  assert.equal(iso(israelDayStart(now)), '2026-11-30T22:00:00.000Z');
});

test('December rolls into January', () => {
  const now = new Date('2026-12-15T10:00:00Z');
  assert.equal(israelDateStr(endOfMonth(now)), '2026-12-31');
  assert.equal(israelDateStr(firstOfNextMonth(now)), '2027-01-01');
});

test('the month that changes clocks still ends on its last day', () => {
  assert.equal(israelDateStr(endOfMonth(new Date('2026-10-10T10:00:00Z'))), '2026-10-31');
  assert.equal(israelDateStr(endOfMonth(new Date('2026-03-10T10:00:00Z'))), '2026-03-31');
});
