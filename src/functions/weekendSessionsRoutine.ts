// EventBridge Scheduled Rule — unix-cron "59 23 * * 6" (Saturday 23:59), Asia/Jerusalem.
//
// For each member with an ACTIVE membership: credit unused weekly slots
// (weeklyLimit - utilized, capped by monthly headroom) to wallet.extraPunches,
// mark weeklyProcessed[weekKey] for idempotency.
//
// Cross-member "all ACTIVE memberships" lookup is a Scan, not a GSI query —
// same <=50-user-scale rationale as getAllMemberProfiles (memberScan.ts);
// this runs once a week.
import { ScanCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem } from '../lib/entities';
import { computeWeekKey } from '../lib/entities';

export async function handler(): Promise<void> {
  const now = new Date();
  const weekKey = computeWeekKey(now);
  console.log(`[weekendSessionsRoutine] weekKey=${weekKey} — starting`);

  const memberships: MembershipItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND #status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE' },
      ExclusiveStartKey: lastKey,
    }));
    memberships.push(...(res.Items ?? []) as MembershipItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  let credited = 0, skipped = 0, errors = 0;

  for (const mem of memberships) {
    const memberId = mem.PK.replace('MEMBER#', '');
    const nowIso = new Date().toISOString();

    try {
      // Re-read fresh (status may have changed since the scan) — mirrors the
      // original's transactional re-read.
      const freshRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: mem.PK, SK: mem.SK } }));
      const fresh = freshRes.Item as MembershipItem | undefined;
      if (!fresh || fresh.status !== 'ACTIVE') { skipped++; continue; }
      if (fresh.weeklyProcessed?.[weekKey]) { skipped++; continue; }

      // Validity window guard — status alone isn't enough: a CUSTOM_MIGRATION
      // item can carry an admin-set startDate/endDate outside "now" even
      // while status is still ACTIVE (e.g. not yet activated, or past its
      // own end but not yet closed out by monthEndRollover). Skip entirely,
      // no credit and no weeklyProcessed write, so it's re-evaluated once it
      // enters its real window.
      const nowMs = Date.now();
      if (fresh.startDate && new Date(fresh.startDate).getTime() > nowMs) { skipped++; continue; }
      if (fresh.endDate && new Date(fresh.endDate).getTime() < nowMs) { skipped++; continue; }

      const weeklyLimit = fresh.weeklyLimit ?? 0;
      const newWeeklyProcessed = { ...fresh.weeklyProcessed, [weekKey]: true };

      if (weeklyLimit <= 0) {
        await ddb.send(new TransactWriteCommand({
          TransactItems: [{
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: mem.PK, SK: mem.SK },
              UpdateExpression: 'SET weeklyProcessed = :wp, updatedAt = :now',
              ExpressionAttributeValues: { ':wp': newWeeklyProcessed, ':now': nowIso },
            },
          }],
        }));
        skipped++;
        continue;
      }

      const monthlyLimit = fresh.monthlyLimit ?? 0;
      const totalUsed = fresh.usage?.totalMonthlyUsed ?? 0;
      const utilized = fresh.weeklyUsage?.[weekKey] ?? 0;

      const rawUnused = Math.max(0, weeklyLimit - utilized);
      const monthlyRoom = Math.max(0, monthlyLimit - totalUsed);
      const unused = Math.min(rawUnused, monthlyRoom);

      if (unused > 0) {
        await ddb.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE_NAME,
                Key: { PK: mem.PK, SK: mem.SK },
                // usage is a DynamoDB reserved keyword — bare here it fails every call.
                UpdateExpression: 'SET weeklyProcessed = :wp, updatedAt = :now ADD #usage.totalMonthlyUsed :unused',
                ExpressionAttributeNames: { '#usage': 'usage' },
                ExpressionAttributeValues: { ':wp': newWeeklyProcessed, ':now': nowIso, ':unused': unused },
              },
            },
            {
              Update: {
                TableName: TABLE_NAME,
                Key: { PK: `MEMBER#${memberId}`, SK: 'WALLET#PRIMARY' },
                UpdateExpression: 'ADD extraPunches :unused SET updatedAt = :now',
                ExpressionAttributeValues: { ':unused': unused, ':now': nowIso },
              },
            },
          ],
        }));
        credited++;
        console.log(`[weekendSessionsRoutine] ${memberId}: utilized=${utilized}/${weeklyLimit} → +${unused} to wallet`);
      } else {
        await ddb.send(new TransactWriteCommand({
          TransactItems: [{
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: mem.PK, SK: mem.SK },
              UpdateExpression: 'SET weeklyProcessed = :wp, updatedAt = :now',
              ExpressionAttributeValues: { ':wp': newWeeklyProcessed, ':now': nowIso },
            },
          }],
        }));
        skipped++;
      }
    } catch (err: any) {
      errors++;
      console.error(`[weekendSessionsRoutine] Error for member=${memberId}:`, err);
    }
  }

  console.log(`[weekendSessionsRoutine] weekKey=${weekKey} done — credited=${credited} skipped=${skipped} errors=${errors}`);
}
