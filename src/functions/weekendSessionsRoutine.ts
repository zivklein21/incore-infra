// EventBridge Scheduled Rule — unix-cron "59 23 * * 4" (Thursday 23:59), Asia/Jerusalem.
// Runs before the Fri/Sat weekend (no classes those days) rather than after
// it, so any unused weekly quota lands in wallet.extraPunches while members
// can still use it to book over the weekend instead of only from Sunday on.
//
// The ONLY place unused membership sessions become wallet credit. Once per
// member per week: weeklyLimit − membership sessions used this week (across
// both months for a week spanning a month end, incl. late cancellations),
// capped by what's left in the month and MAX_MONTHLY_ROLLOVER per month.
// weeklyProcessed[weekKey] makes it idempotent.
//
// Cross-member "all ACTIVE memberships" lookup is a Scan, not a GSI query —
// same <=50-user-scale rationale as getAllMemberProfiles (memberScan.ts);
// this runs once a week.
import { ScanCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem } from '../lib/entities';
import { computeWeekKey, weeklyUsedAcrossMemberships, getEffectiveMonthlyLimit, rolloverRoomLeft } from '../lib/entities';
import { ensureCreditBuckets, addCreditItem } from '../lib/walletCredit';

// Late cancellations of membership classes this week. cancelBooking frees
// the weekly slot on a late cancel (so she can rebook that week), but the
// session itself is lost — it still counts as used, never as unused.
async function lateMembershipCancelsInWeek(memberId: string, weekKey: string): Promise<number> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: 'weekKey = :wk AND #status = :late AND consumedFrom = :membership',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'CANCEL#', ':wk': weekKey, ':late': 'LATE_CANCELLED', ':membership': 'MEMBERSHIP' },
  }));
  return res.Items?.length ?? 0;
}

export async function handler(): Promise<void> {
  const now = new Date();
  const weekKey = computeWeekKey(now);
  console.log(`[weekendSessionsRoutine] weekKey=${weekKey} — starting`);

  // Every membership record, not just ACTIVE — a week spanning two months
  // has part of its usage on the previous month's (by now closed) record.
  const allMemberships: MembershipItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#' },
      ExclusiveStartKey: lastKey,
    }));
    allMemberships.push(...(res.Items ?? []) as MembershipItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const byMember = new Map<string, MembershipItem[]>();
  for (const m of allMemberships) byMember.set(m.PK, [...(byMember.get(m.PK) ?? []), m]);

  // Each member's week is settled exactly once, on its Thursday, against ONE
  // record: the membership active now; or — when there's none (e.g. the week
  // of Sun 27/9–Sat 3/10, September closed on 30/9 and no October membership
  // yet) — the one that covered the start of this week. Month-end no longer
  // converts anything, so this is the only place unused sessions become credit.
  const nowMs = now.getTime();
  // A membership settles a week only if it covered at least Sun–Tue of it
  // (3 of the 5 training days): one that ended Sunday/Monday, or started
  // Wednesday/Thursday, doesn't earn a whole week's unused sessions.
  const tuesday = new Date(`${weekKey}T00:00:00Z`);
  tuesday.setUTCDate(tuesday.getUTCDate() + 2);
  const minEndIso = tuesday.toISOString().slice(0, 19);
  const inWindow = (m: MembershipItem) =>
    (!m.startDate || new Date(m.startDate).getTime() <= nowMs) && (!m.endDate || new Date(m.endDate).getTime() >= nowMs);
  const memberships: MembershipItem[] = [];
  for (const records of byMember.values()) {
    if (records.some((m) => m.weeklyProcessed?.[weekKey])) continue; // already settled
    const byNewest = [...records].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '') || b.targetMonth.localeCompare(a.targetMonth));
    // Must also have covered the start of the week (from Tuesday at the
    // latest) — an October membership starting Thu 1/10 doesn't earn the
    // whole week of Sun 27/9, most of which belonged to September.
    const target = byNewest.find((m) => m.status === 'ACTIVE' && inWindow(m) && (!m.startDate || m.startDate <= `${minEndIso}.999Z`))
      ?? byNewest.find((m) => m.status !== 'CANCELLED' && !!m.endDate && m.endDate >= minEndIso
        && (!m.startDate || m.startDate <= `${minEndIso}.999Z`));
    if (target) memberships.push(target);
  }

  let credited = 0, skipped = 0, errors = 0;

  for (const mem of memberships) {
    const memberId = mem.PK.replace('MEMBER#', '');
    const nowIso = new Date().toISOString();

    try {
      // Re-read fresh (status may have changed since the scan) — mirrors the
      // original's transactional re-read.
      const freshRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: mem.PK, SK: mem.SK } }));
      const fresh = freshRes.Item as MembershipItem | undefined;
      if (!fresh || fresh.status === 'CANCELLED') { skipped++; continue; }
      if (fresh.weeklyProcessed?.[weekKey]) { skipped++; continue; }

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

      // Effective limit (incl. manualAdjustment) — same total bookClass enforces.
      const monthlyLimit = getEffectiveMonthlyLimit(fresh);
      const totalUsed = fresh.usage?.totalMonthlyUsed ?? 0;
      // Membership sessions used this week (classes paid from the membership,
      // across all her records for a week spanning two months) plus late
      // cancellations of them. Classes paid with credit or a punch card don't
      // use the membership — their slot is still unused membership quota.
      const siblings = (byMember.get(mem.PK) ?? []).filter((m) => m.SK !== mem.SK);
      const utilized = weeklyUsedAcrossMemberships([fresh, ...siblings], weekKey)
        + await lateMembershipCancelsInWeek(memberId, weekKey);

      const rawUnused = Math.max(0, weeklyLimit - utilized);
      const monthlyRoom = Math.max(0, monthlyLimit - totalUsed);
      // At most MAX_MONTHLY_ROLLOVER credits per membership month.
      const unused = Math.min(rawUnused, monthlyRoom, rolloverRoomLeft(fresh));

      if (unused > 0) {
        await ensureCreditBuckets(memberId);
        await ddb.send(new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE_NAME,
                Key: { PK: mem.PK, SK: mem.SK },
                // usage is a DynamoDB reserved keyword — bare here it fails every call.
                UpdateExpression: 'SET weeklyProcessed = :wp, updatedAt = :now ADD #usage.totalMonthlyUsed :unused, #usage.rolledToCredit :unused',
                ExpressionAttributeNames: { '#usage': 'usage' },
                ExpressionAttributeValues: { ':wp': newWeeklyProcessed, ':now': nowIso, ':unused': unused },
              },
            },
            addCreditItem(memberId, unused, nowIso),
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
