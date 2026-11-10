// Moves pre-rebuild FORCA chat threads onto the new model (see
// src/lib/forcaChat/migration.ts for exactly what changes and why).
//
// Dry run (read-only, prints counts and every planned change):
//   TABLE_NAME=incore-production-table FORCA_TABLE_NAME=forca-production-table AWS_REGION=eu-central-1 \
//     npx --yes --package=tsx@4.19.2 -- tsx scripts/migrateForcaChat.ts
// Apply (only after the dry run is approved):  … scripts/migrateForcaChat.ts --apply
//
// Writes only the thread METADATA items; messages are never touched. Each
// write is conditioned on the thread being unmigrated and its lastMessageAt
// unchanged since it was read, so a thread that got a message meanwhile is
// skipped and reported (run again to pick it up). Safe to re-run.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../src/lib/dynamo';
import type { ForcaSupportInquiryItem } from '../src/lib/entities';
import { listForcaCoaches } from '../src/lib/forcaChat/store';
import { planThreadMigration, type MigrationKind } from '../src/lib/forcaChat/migration';

const apply = process.argv.includes('--apply');

async function scanThreads(): Promise<ForcaSupportInquiryItem[]> {
  const items: ForcaSupportInquiryItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :p) AND SK = :m',
      ExpressionAttributeValues: { ':p': 'FORCAINQUIRY#', ':m': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...((res.Items ?? []) as ForcaSupportInquiryItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function main() {
  if (!FORCA_TABLE_NAME) throw new Error('FORCA_TABLE_NAME is not set');
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${FORCA_TABLE_NAME}\n`);

  const [threads, coaches] = await Promise.all([scanThreads(), listForcaCoaches()]);
  const coachesByGroup = new Map<string, { uid: string; name: string }[]>();
  for (const c of coaches) for (const g of c.groupIds) coachesByGroup.set(g, [...(coachesByGroup.get(g) ?? []), { uid: c.uid, name: c.name }]);

  const plans = threads.map((t) => ({ t, plan: planThreadMigration(t, coachesByGroup) }));
  const byKind = new Map<MigrationKind, number>();
  const byOwner = { trainee: 0, parent: 0 };
  const coachGroups = new Map<string, { coaches: number; threads: number }>();
  for (const { t, plan } of plans) {
    byKind.set(plan.kind, (byKind.get(plan.kind) ?? 0) + 1);
    if (plan.kind === 'already_migrated') continue;
    byOwner[plan.ownerRole] += 1;
    if (t.recipientRole === 'coach' && plan.groupId) {
      const g = coachGroups.get(plan.groupId) ?? { coaches: coachesByGroup.get(plan.groupId)?.length ?? 0, threads: 0 };
      g.threads += 1;
      coachGroups.set(plan.groupId, g);
    }
  }

  console.log(`Threads found: ${threads.length}`);
  console.log(`To migrate:    ${threads.length - (byKind.get('already_migrated') ?? 0)} (already migrated: ${byKind.get('already_migrated') ?? 0})\n`);
  console.log('By owner role');
  console.log(`  started by a trainee (stay with her):          ${byOwner.trainee}`);
  console.log(`  started by a parent (move to the parent):      ${byOwner.parent}\n`);
  console.log('By recipient');
  console.log(`  to the admin:                                   ${byKind.get('admin') ?? 0}`);
  console.log(`  to a coach, group has 1 coach (assigned to her): ${byKind.get('coach_assigned_single') ?? 0}`);
  console.log(`  to a coach, group has several (stays group):     ${byKind.get('coach_group_multiple') ?? 0}`);
  console.log(`  to a coach, group has no coach now:              ${byKind.get('coach_group_none') ?? 0}`);
  console.log(`  to a coach, no group on the thread:              ${byKind.get('coach_no_group') ?? 0}\n`);
  console.log('Coach threads by group');
  for (const [groupId, g] of coachGroups) {
    const label = g.coaches === 1 ? '1 coach -> assigned' : g.coaches === 0 ? 'no coach -> nobody sees it until one is assigned' : `${g.coaches} coaches -> stays a group thread`;
    console.log(`  ${groupId}: ${g.threads} thread(s), ${label}`);
  }
  console.log('\nPlanned changes');
  for (const { plan } of plans) {
    if (plan.kind === 'already_migrated') continue;
    console.log(`  ${plan.id} [${plan.kind}, ${plan.ownerRole}] ${JSON.stringify(plan.set)}`);
  }

  if (!apply) {
    console.log('\nDry run only. Nothing written.');
    return;
  }

  let written = 0;
  const skipped: string[] = [];
  for (const { t, plan } of plans) {
    if (plan.kind === 'already_migrated') continue;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = Object.entries(plan.set).map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      return `#f${i} = :v${i}`;
    });
    const seen = t.lastMessageAt;
    try {
      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: { PK: t.PK, SK: 'METADATA' },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: `attribute_not_exists(ownerUid) AND ${seen ? 'lastMessageAt = :seen' : 'attribute_not_exists(lastMessageAt)'}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ...values, ...(seen ? { ':seen': seen } : {}) },
      }));
      written += 1;
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') skipped.push(plan.id);
      else throw err;
    }
  }
  console.log(`\nWritten: ${written}. Skipped (changed meanwhile, run again): ${skipped.length}${skipped.length ? ` ${skipped.join(', ')}` : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
