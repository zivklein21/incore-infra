// Run: TABLE_NAME=incore-production-table AWS_REGION=eu-central-1 \
//   npx --yes --package=tsx@4.19.2 -- tsx scripts/fixMembershipStatuses.ts [--apply]
// Dry run unless --apply is passed. INCORE only. One-time, after the
// expireMemberships deploy.
//
// Writes (with --apply) only one thing: status 'expired' (lowercase, written
// by monthEndRollover for CUSTOM_MIGRATION) → 'EXPIRED'. Each write is
// conditional on the lowercase value it read; nothing else on the item changes.
//
// Reports (never writes): what the hourly expireMemberships job would do right
// now — memberships it would expire, and members whose future bookings it
// would cancel. That job does those itself, with its push and its log.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../src/lib/dynamo';
import { cleanupStep, expireStep, scanAllMemberships } from '../src/functions/expireMemberships';

const apply = process.argv.includes('--apply');

async function lowercaseExpired(): Promise<{ PK: string; SK: string }[]> {
  const out: { PK: string; SK: string }[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND #status = :lower',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':lower': 'expired' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as { PK: string; SK: string }[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

(async () => {
  if (!TABLE_NAME) throw new Error('TABLE_NAME is not set');
  console.log(`${apply ? 'APPLY (casing only)' : 'DRY RUN'} on ${TABLE_NAME}\n`);

  const lower = await lowercaseExpired();
  console.log(`1. Lowercase 'expired' → 'EXPIRED': ${lower.length} membership(s)`);
  let fixed = 0;
  for (const m of lower) {
    console.log(`   ${m.PK} ${m.SK}`);
    if (!apply) continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: m.PK, SK: m.SK },
        UpdateExpression: 'SET #status = :upper',
        ConditionExpression: '#status = :lower',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':upper': 'EXPIRED', ':lower': 'expired' },
      }));
      fixed++;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  // Report only — always a dry run.
  const now = new Date();
  const all = await scanAllMemberships();
  const expired = await expireStep(all, now, true);
  console.log(`\n2. Report: the hourly job would now expire ${expired.filter((r) => r.action === 'expire').length}, hold ${expired.filter((r) => r.action === 'renewal_grace').length} for renewal`);
  for (const r of expired) console.log(`   ${r.action.padEnd(13)} ${r.memberId} ${r.SK} ("${r.productName}", ended ${r.endsAt})`);
  for (const r of expired) if (r.action === 'expire') { const m = all.find((x) => x.PK === `MEMBER#${r.memberId}` && x.SK === r.SK); if (m) m.status = 'EXPIRED'; }
  const cleanups = await cleanupStep(all, now, true);
  console.log(`3. Report: future bookings it would cancel for ${cleanups.length} member(s)`);
  for (const c of cleanups) console.log(`   ${c.memberId}: ${c.bookings.length} booking(s) ${JSON.stringify(c.bookings)}`);

  console.log(apply ? `\nDone: ${fixed} status(es) uppercased. Nothing else written.` : '\nNothing written. Re-run with --apply to uppercase the statuses in 1.');
})().catch((err) => { console.error(err); process.exit(1); });
