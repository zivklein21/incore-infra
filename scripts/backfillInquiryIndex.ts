// Run: npx --yes --package=tsx@4.19.2 -- tsx scripts/backfillInquiryIndex.ts [--apply]
// Dry run unless --apply is passed. Run with --apply right after deploying
// the history-paging Lambdas (before the 1.5.2 app reaches admins).
//
// The paged support inboxes (getAllInquiries / getAllForcaInquiries /
// getCoachForcaInquiries with ?paged=1) read one GSI2 partition per brand
// instead of scanning the table (lib/inquiryFeed.ts). New inquiries get the
// key at creation; this adds it to older ones so none drop out of the inbox.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME, TABLE_NAME } from '../src/lib/dynamo';
import { FORCA_INQUIRY_GSI2PK, INCORE_INQUIRY_GSI2PK } from '../src/lib/inquiryFeed';

const apply = process.argv.includes('--apply');

async function missing(table: string, prefix: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :meta AND attribute_not_exists(GSI2PK)',
      ExpressionAttributeValues: { ':prefix': prefix, ':meta': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

(async () => {
  const targets = [
    { table: TABLE_NAME, prefix: 'INQUIRY#', gsi2pk: INCORE_INQUIRY_GSI2PK, label: 'INCORE' },
    { table: FORCA_TABLE_NAME, prefix: 'FORCAINQUIRY#', gsi2pk: FORCA_INQUIRY_GSI2PK, label: 'FORCA' },
  ];
  for (const t of targets) {
    const rows = await missing(t.table, t.prefix);
    console.log(`${t.label} inquiries missing GSI2: ${rows.length}`);
    if (!apply) continue;
    for (const r of rows) {
      const id = String(r.PK).replace(t.prefix, '');
      const created = typeof r.createdAt === 'string' ? r.createdAt : '1970-01-01T00:00:00.000Z';
      await ddb.send(new UpdateCommand({
        TableName: t.table,
        Key: { PK: r.PK, SK: r.SK },
        UpdateExpression: 'SET GSI2PK = :pk, GSI2SK = :sk',
        ConditionExpression: 'attribute_not_exists(GSI2PK)',
        ExpressionAttributeValues: { ':pk': t.gsi2pk, ':sk': `${created}#${id}` },
      }));
    }
    console.log(`${t.label}: fixed ${rows.length}.`);
  }
  if (!apply) console.log('Dry run — pass --apply to write.');
})().catch((err) => { console.error(err); process.exit(1); });
