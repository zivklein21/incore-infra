// Run (read-only, both brands):
//   TABLE_NAME=incore-production-table FORCA_TABLE_NAME=forca-production-table AWS_REGION=eu-central-1 \
//     npx --yes --package=tsx@4.19.2 -- tsx scripts/checkSessionDayIndex.ts
// Apply (after the dry-run list is approved):  … scripts/checkSessionDayIndex.ts --apply
// Optional: --brand incore|forca to limit to one table.
//
// Finds sessions moved to another day before every move path kept the day
// index in step (see src/lib/sessionMove.ts): a ClassItem whose GSI2PK isn't
// CLASSDATE#<its Israel day> still shows on its OLD day in the coach
// calendar / schedule / reminders / activity picker, and is missing from its
// new day. Also lists registrations whose classDate copy differs from the
// session's date. Dry run prints exactly what --apply would write. --apply
// changes only GSI2PK/GSI2SK on the class item, and classDate (+ a stale
// reminderSent on a future session) on its registrations — never dates,
// statuses, credits or rosters. Each write is conditioned on the value read,
// so anything edited meanwhile is skipped and reported.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME, TABLE_NAME } from '../src/lib/dynamo';
import { planDayIndexRepairs, type DayIndexRepair } from '../src/lib/sessionMove';

const apply = process.argv.includes('--apply');
const brandArg = process.argv[process.argv.indexOf('--brand') + 1];
const tables = [
  { brand: 'incore', table: TABLE_NAME },
  { brand: 'forca', table: FORCA_TABLE_NAME },
].filter(t => !process.argv.includes('--brand') || t.brand === brandArg);

async function scanClassItems(table: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(PK, :p) AND (SK = :m OR begins_with(SK, :r))',
      ExpressionAttributeValues: { ':p': 'CLASS#', ':m': 'METADATA', ':r': 'REG#' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function applyRepair(table: string, r: DayIndexRepair, meta: Record<string, unknown>): Promise<string[]> {
  const skipped: string[] = [];
  if (r.fixIndex) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: table,
        Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' },
        UpdateExpression: 'SET GSI2PK = :pk, GSI2SK = :sk',
        ConditionExpression: '#date = :date',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: { ':pk': r.fixIndex.GSI2PK, ':sk': r.fixIndex.GSI2SK, ':date': meta.date },
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      skipped.push(`${r.classId} (date changed since the scan)`);
    }
  }
  for (const reg of r.staleRegistrations) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: table,
        Key: { PK: reg.PK, SK: reg.SK },
        UpdateExpression: `SET classDate = :d${reg.clearReminder ? ' REMOVE reminderSent, reminderSentAt' : ''}`,
        ConditionExpression: reg.classDate === null ? 'attribute_not_exists(classDate)' : 'classDate = :old',
        ExpressionAttributeValues: { ':d': r.date, ...(reg.classDate === null ? {} : { ':old': reg.classDate }) },
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      skipped.push(`${reg.PK} ${reg.SK} (changed since the scan)`);
    }
  }
  return skipped;
}

(async () => {
  console.log(apply ? '*** APPLY ***' : 'Dry run (read-only) — nothing is written. Re-run with --apply to fix.');
  for (const { brand, table } of tables) {
    const items = await scanClassItems(table);
    const repairs = planDayIndexRepairs(items);
    const metas = new Map(items.filter(i => i.SK === 'METADATA').map(i => [String(i.PK), i]));
    const moved = repairs.filter(r => r.fixIndex);
    const regsOnly = repairs.filter(r => !r.fixIndex);
    console.log(`\n== ${brand} (${table}) — ${metas.size} sessions scanned`);
    console.log(`Shown on the wrong day (day index): ${moved.length}`);
    for (const r of moved) {
      console.log(`  ${r.classId}  "${r.className}"  real day ${r.day} (${r.date})  indexed on ${r.indexedDay ?? '— missing —'}  → ${r.fixIndex!.GSI2PK}`
        + (r.staleRegistrations.length ? `  + ${r.staleRegistrations.length} registration(s) classDate` : ''));
    }
    console.log(`Right day, but registrations with an old classDate: ${regsOnly.length}`);
    for (const r of regsOnly) {
      console.log(`  ${r.classId}  "${r.className}"  ${r.day}  ${r.staleRegistrations.length} registration(s): `
        + r.staleRegistrations.map(x => `${x.SK.replace('REG#', '')}[${x.status}] ${x.classDate ?? '—'}${x.clearReminder ? ' (reminder reset)' : ''}`).join(', '));
    }
    if (apply) {
      const skipped: string[] = [];
      for (const r of repairs) skipped.push(...await applyRepair(table, r, metas.get(`CLASS#${r.classId}`)!));
      console.log(`Applied: ${moved.length} day index fix(es), ${repairs.reduce((n, r) => n + r.staleRegistrations.length, 0)} registration(s); skipped ${skipped.length}`);
      for (const s of skipped) console.log(`  skipped ${s}`);
    }
  }
})().catch(err => { console.error(err); process.exit(1); });
