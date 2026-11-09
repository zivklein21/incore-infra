// Run: npx --yes --package=tsx@4.19.2 -- tsx scripts/backfillRegistrationIndex.ts [--apply]
// Dry run unless --apply is passed. Run the dry run BEFORE deploying the
// history-paging Lambdas; if it reports 0 missing, nothing else is needed.
//
// FORCA attendance history (getMyAttendanceHistory / getChildAttendanceHistory)
// now reads a trainee's registrations off GSI1 (GSI1PK=MEMBER#<uid>,
// GSI1SK=REG##<classId>) instead of scanning the table. Every current writer
// sets those keys; this finds and fixes any older registration that doesn't,
// so no past session drops out of her history. INCORE rows are only counted
// (INCORE has read them via GSI1 all along).
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME, TABLE_NAME } from '../src/lib/dynamo';

const apply = process.argv.includes('--apply');

async function missing(table: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(SK, :reg) AND begins_with(PK, :cls) AND attribute_not_exists(GSI1PK)',
      ExpressionAttributeValues: { ':reg': 'REG#', ':cls': 'CLASS#' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

(async () => {
  const forca = await missing(FORCA_TABLE_NAME);
  const incore = await missing(TABLE_NAME);
  console.log(`FORCA registrations missing GSI1: ${forca.length}`);
  console.log(`INCORE registrations missing GSI1 (report only): ${incore.length}`);

  let fixed = 0;
  for (const r of forca) {
    const uid = String(r.SK).replace('REG#', '');
    const classId = String(r.PK).replace('CLASS#', '');
    if (!apply) continue;
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: r.PK, SK: r.SK },
      UpdateExpression: 'SET GSI1PK = :pk, GSI1SK = :sk',
      ConditionExpression: 'attribute_not_exists(GSI1PK)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':sk': `REG##${classId}` },
    }));
    fixed += 1;
  }
  console.log(apply ? `Fixed ${fixed}.` : 'Dry run — pass --apply to write.');
})().catch((err) => { console.error(err); process.exit(1); });
