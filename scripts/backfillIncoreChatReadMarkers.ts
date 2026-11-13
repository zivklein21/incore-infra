// INCORE chat read markers: marks every existing thread read up to its last
// message for both sides (memberReadAt / adminReadAt = lastMessageAt), so
// turning on read markers doesn't light up a pile of unread badges.
// See src/lib/incoreChatRead.ts.
//
// Dry run (read-only, prints counts and every planned change):
//   TABLE_NAME=incore-production-table FORCA_TABLE_NAME=forca-production-table AWS_REGION=eu-central-1 \
//     npx --yes --package=tsx@4.19.2 -- tsx scripts/backfillIncoreChatReadMarkers.ts
// Apply (only after the dry run is approved):  … --apply
//
// Writes only the missing marker(s) on INQUIRY# METADATA items; each write is
// conditioned on lastMessageAt being unchanged since it was read, so a thread
// that got a message meanwhile is skipped (run again). Safe to re-run.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../src/lib/dynamo';
import type { SupportInquiryItem } from '../src/lib/entities';
import { isIncoreUnreadFor, planReadMarkerBackfill } from '../src/lib/incoreChatRead';

const apply = process.argv.includes('--apply');

async function main() {
  if (!TABLE_NAME) throw new Error('TABLE_NAME is not set');
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${TABLE_NAME}\n`);

  const threads: SupportInquiryItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :p) AND SK = :m',
      ExpressionAttributeValues: { ':p': 'INQUIRY#', ':m': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    threads.push(...((res.Items ?? []) as SupportInquiryItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const plans = threads.map((t) => ({ t, set: planReadMarkerBackfill(t) })).filter((p) => p.set);
  const unreadMember = plans.filter(({ t }) => isIncoreUnreadFor(t, 'member')).length;
  const unreadAdmin = plans.filter(({ t }) => isIncoreUnreadFor(t, 'admin')).length;
  console.log(`Threads found:            ${threads.length}`);
  console.log(`To mark read:             ${plans.length}`);
  console.log(`  unread for the member today (dot clears): ${unreadMember}`);
  console.log(`  unread for the admin today (badge drops): ${unreadAdmin}\n`);
  for (const { t, set } of plans) console.log(`  ${t.PK} [${t.status}] ${JSON.stringify(set)}`);

  if (!apply) {
    console.log('\nDry run only. Nothing written.');
    return;
  }

  let written = 0;
  const skipped: string[] = [];
  for (const { t, set } of plans) {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = Object.entries(set!).map(([k, v], i) => { names[`#f${i}`] = k; values[`:v${i}`] = v; return `#f${i} = :v${i}`; });
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: t.PK, SK: 'METADATA' },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: t.lastMessageAt ? 'lastMessageAt = :seen' : 'attribute_not_exists(lastMessageAt)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ...values, ...(t.lastMessageAt ? { ':seen': t.lastMessageAt } : {}) },
      }));
      written += 1;
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') skipped.push(t.PK);
      else throw err;
    }
  }
  console.log(`\nWritten: ${written}. Skipped (changed meanwhile, run again): ${skipped.length}${skipped.length ? ` ${skipped.join(', ')}` : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
