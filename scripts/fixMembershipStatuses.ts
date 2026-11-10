// Run: TABLE_NAME=incore-production-table AWS_REGION=eu-central-1 \
//   npx --yes --package=tsx@4.19.2 -- tsx scripts/fixMembershipStatuses.ts [--apply]
// Dry run unless --apply is passed. INCORE only. One-time, alongside the
// expireMemberships deploy (which keeps statuses right from then on).
//
// 1. Every ACTIVE/PENDING membership gets what expireMemberships would do now:
//    past its last day (Israel time) → EXPIRED, PENDING that has started →
//    ACTIVE. Auto-renewing ones with an active billing agreement inside the
//    48h renewal grace are reported and left alone. Same code as the job.
// 2. status 'expired' (lowercase, written by monthEndRollover for
//    CUSTOM_MIGRATION) → 'EXPIRED'. Nothing else about those items changes.
//
// Every write is conditional on the status it read, so a renewal or an admin
// edit in between wins.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../src/lib/dynamo';
import { sweepMemberships } from '../src/functions/expireMemberships';

const apply = process.argv.includes('--apply');

async function lowercaseExpired(): Promise<{ PK: string; SK: string; targetMonth?: string; productName?: string }[]> {
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
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${TABLE_NAME}\n`);

  const rows = await sweepMemberships(new Date(), !apply);
  console.log(`1. Status by date: ${rows.length} membership(s)`);
  for (const r of rows) console.log(`   ${r.action.padEnd(13)} ${r.memberId} ${r.SK} (${r.status}, "${r.productName}", ended/starts ${r.endsAt})`);

  const lower = await lowercaseExpired();
  console.log(`\n2. Lowercase 'expired' → 'EXPIRED': ${lower.length} membership(s)`);
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

  console.log(apply
    ? `\nDone: ${rows.filter((r) => r.action === 'expire' || r.action === 'activate').length} status-by-date change(s) attempted, ${fixed} lowercase fixed.`
    : '\nNothing written. Re-run with --apply.');
})().catch((err) => { console.error(err); process.exit(1); });
