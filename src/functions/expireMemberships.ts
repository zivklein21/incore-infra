// EventBridge Scheduled Rule — "cron(5 * * * ? *)" (hourly, :05), Asia/Jerusalem.
// INCORE only. Two steps, both by date (rules in lib/membershipExpiry.ts):
//
// 1. Expire: an ACTIVE membership past the end of its last day (Israel time)
//    becomes EXPIRED. An auto-renewing one with an active billing agreement
//    waits up to RENEWAL_GRACE_MS: chargeHypBillingAgreements (03:00 on the
//    1st, a decline retried the next day) replaces it on success.
//    PENDING (new member not yet paid / future-dated admin grant) is not
//    touched — activatePendingMemberships owns it.
//
// 2. Clean up: a member whose membership really ended (nothing ACTIVE left
//    to run, no renewal pending — needsBookingCleanup) loses the future
//    bookings it paid for (credit / punch-card bookings stay) and always gets
//    a push saying it ended (lib/membershipExpiryCleanup.ts). A declined
//    renewal is expired by chargeOneAgreement only after its retry fails;
//    this step then picks it up.
//    Runs once per ended membership (expiryCleanupAt); only for memberships
//    that ended in the last CLEANUP_LOOKBACK_MS, so history is never touched.
//
// Before this, nothing expired a regular subscription by date (monthEndRollover
// only marks it processed; billing only on a renewal or a decline), and
// checkout then sold the member the NEXT month, as if this one were covered.
//
// Invoke with {"dryRun": true} to log what it would do without writing.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem } from '../lib/entities';
import { queryOpenAgreementsForMember } from '../lib/hypAgreementQueries';
import { CLEANUP_LOOKBACK_MS, membershipEndsAt, needsBookingCleanup, sweepAction, type SweepAction } from '../lib/membershipExpiry';
import { cleanUpAfterExpiry } from '../lib/membershipExpiryCleanup';

type Item = MembershipItem & { productName?: string; expiryCleanupAt?: string };

export async function scanAllMemberships(): Promise<Item[]> {
  const out: Item[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND begins_with(PK, :member)',
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':member': 'MEMBER#' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as Item[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** Whether the member has an active (not paused/cancelled/failed) subscription agreement that will renew. */
function makeRenewalLookup(): (memberId: string) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (memberId) => {
    if (!cache.has(memberId)) {
      const agreements = await queryOpenAgreementsForMember(memberId, 'subscription');
      cache.set(memberId, agreements.some((a) => a.status === 'active'));
    }
    return cache.get(memberId)!;
  };
}

export interface SweepRow { memberId: string; SK: string; action: SweepAction; status: string; endsAt: string; productName: string }
export interface CleanupRow { memberId: string; endedSKs: string[]; cancelled: number; bookings: string[] }

/** Step 1. Shared with scripts/fixMembershipStatuses.ts (report only there). */
export async function expireStep(all: Item[], now: Date, dryRun: boolean, hasActiveRenewal = makeRenewalLookup()): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];
  const nowIso = now.toISOString();
  for (const m of all) {
    const memberId = m.PK.replace('MEMBER#', '');
    let action = sweepAction(m, now, false);
    if (action === 'expire' && m.isAutoRenew === true) action = sweepAction(m, now, await hasActiveRenewal(memberId));
    if (action === 'none') continue;
    rows.push({ memberId, SK: m.SK, action, status: m.status, endsAt: membershipEndsAt(m).toISOString(), productName: m.productName ?? '' });
    if (dryRun || action !== 'expire') continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: m.PK, SK: m.SK },
        UpdateExpression: 'SET #status = :expired, expiredAt = :now, expiredBy = :by, updatedAt = :now',
        // Only if nothing (a renewal, an admin edit) changed it since the scan.
        ConditionExpression: '#status = :prev',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': nowIso, ':by': 'expireMemberships', ':prev': m.status },
      }));
      m.status = 'EXPIRED';
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') console.error(`[expireMemberships] expire failed member=${memberId} SK=${m.SK}`, err);
    }
  }
  return rows;
}

/** Step 2. */
export async function cleanupStep(all: Item[], now: Date, dryRun: boolean, hasActiveRenewal = makeRenewalLookup()): Promise<CleanupRow[]> {
  const byMember = new Map<string, Item[]>();
  for (const m of all) {
    const id = m.PK.replace('MEMBER#', '');
    byMember.set(id, [...(byMember.get(id) ?? []), m]);
  }
  const rows: CleanupRow[] = [];
  for (const [memberId, items] of byMember) {
    // Cheap pre-check without the agreement lookup: anything to do at all?
    if (!needsBookingCleanup(items, now, false)) continue;
    if (!needsBookingCleanup(items, now, await hasActiveRenewal(memberId))) continue;
    const ended = items.filter((m) => {
      const s = (m.status ?? '').toUpperCase();
      const endsAt = membershipEndsAt(m).getTime();
      return (s === 'EXPIRED' || s === 'ACTIVE') && !m.expiryCleanupAt && endsAt <= now.getTime() && now.getTime() - endsAt <= CLEANUP_LOOKBACK_MS;
    });
    try {
      const res = await cleanUpAfterExpiry(memberId, ended, now, dryRun);
      rows.push({
        memberId, endedSKs: ended.map((m) => m.SK), cancelled: res.cancelled.length,
        bookings: dryRun ? res.wouldCancel : res.cancelled.map((c) => `${c.classId}@${c.classDate}(${c.consumedFrom})`),
      });
    } catch (err) {
      console.error(`[expireMemberships] cleanup failed member=${memberId}`, err);
    }
  }
  return rows;
}

export async function handler(event?: { dryRun?: boolean }): Promise<{ dryRun: boolean; expired: SweepRow[]; cleanups: CleanupRow[] }> {
  const dryRun = event?.dryRun === true;
  const now = new Date();
  const all = await scanAllMemberships();
  const hasActiveRenewal = makeRenewalLookup();
  const expired = await expireStep(all, now, dryRun, hasActiveRenewal);
  const cleanups = await cleanupStep(all, now, dryRun, hasActiveRenewal);

  const tag = `[expireMemberships]${dryRun ? ' DRY' : ''}`;
  for (const r of expired) console.log(`${tag} ${r.action} member=${r.memberId} SK=${r.SK} endsAt=${r.endsAt}`);
  for (const c of cleanups) console.log(`${tag} cleanup member=${c.memberId} ended=${c.endedSKs.join(',')} bookings=${JSON.stringify(c.bookings)}`);
  console.log(`${tag} expired=${expired.filter((r) => r.action === 'expire').length} renewal_grace=${expired.filter((r) => r.action === 'renewal_grace').length} cleanups=${cleanups.length}`);
  return { dryRun, expired, cleanups };
}
