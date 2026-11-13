// Run: npx --yes --package=tsx@4.19.2 -- tsx scripts/backfillSessionPlanOverrides.ts [--apply]
// Dry run unless --apply is passed. Run it once, right after deploying.
//
// Sessions customized through the old admin "Edit plan for this session only"
// flow point at a private plan copy, but have no ClassItem.planOverride. Until
// they do, they show no badge, can't be reset, and a recurring-template change
// would overwrite them. Copies whose session no longer uses them are reported
// and left alone.
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../src/lib/dynamo';
import type { ClassItem, WorkoutPlanItem } from '../src/lib/entities';

const apply = process.argv.includes('--apply');

async function sessionCopies(): Promise<WorkoutPlanItem[]> {
  const copies: WorkoutPlanItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'SK = :metadata AND attribute_exists(sessionCopyOf)',
      ExpressionAttributeValues: { ':metadata': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    copies.push(...((res.Items ?? []) as WorkoutPlanItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return copies;
}

(async () => {
  const copies = await sessionCopies();
  let backfilled = 0;
  let alreadyDone = 0;
  const unused: string[] = [];

  for (const copy of copies) {
    const copyId = copy.PK.replace('WORKOUTPLAN#', '');
    const key = { PK: `CLASS#${copy.sessionClassId}`, SK: 'METADATA' };
    const session = (await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }))).Item as ClassItem | undefined;
    if (!session || session.workoutPlanId !== copyId) { unused.push(copyId); continue; }
    if (session.planOverride) { alreadyDone += 1; continue; }

    backfilled += 1;
    if (!apply) continue;
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET planOverride = :override',
      ExpressionAttributeValues: {
        ':override': {
          basePlanId: copy.sessionCopyOf,
          basePlanName: session.workoutPlanName ?? copy.name,
          editedAt: copy.createdAt,
          // The old flow was admin-only.
          editedBy: { uid: copy.createdBy, name: 'אור שרעף', role: 'admin' },
        },
      },
    }));
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', copies: copies.length, backfilled, alreadyDone, unused }, null, 2));
})();
