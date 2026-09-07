// EventBridge Scheduled Rule — unix-cron "5 3 * * *" (03:05 daily), Asia/Jerusalem.
// Flips PENDING memberships (future-dated CUSTOM_MIGRATION grants — see
// adminGrantCustomMigration.ts) to ACTIVE once their startDate has arrived.
// Nothing else creates PENDING memberships today.
//
// Why 03:05 and not right after local midnight: adminGrantCustomMigration.ts
// computes startDate with Date#setHours(0,0,0,0), which zeroes to midnight in
// the Lambda's runtime timezone. Lambda's Node runtime defaults to UTC (no TZ
// env var is set — see lambdas.tf), so the stored startDate is actually UTC
// midnight, not Israel-local midnight. Israel is UTC+2/+3, so UTC midnight
// only arrives at 02:00-03:00 Israel time. Running this before 03:00 Israel
// (the old schedule ran at 01:00) meant "today's" startDate hadn't crossed
// its UTC boundary yet, so same-day memberships were skipped for a full
// extra day. 03:05 is safely past that boundary year-round.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem } from '../lib/entities';

export async function handler(): Promise<void> {
  const nowIso = new Date().toISOString();
  const memberships: MembershipItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND #status = :pending AND attribute_exists(startDate) AND startDate <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':pending': 'PENDING', ':now': nowIso },
      ExclusiveStartKey: lastKey,
    }));
    memberships.push(...(res.Items ?? []) as MembershipItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  if (memberships.length === 0) {
    console.log('[activatePendingMemberships] nothing to activate');
    return;
  }

  await Promise.all(memberships.map((m) =>
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: m.PK, SK: m.SK },
      UpdateExpression: 'SET #status = :active, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'ACTIVE', ':now': nowIso },
    })),
  ));

  console.log(`[activatePendingMemberships] activated=${memberships.length}`);
}
