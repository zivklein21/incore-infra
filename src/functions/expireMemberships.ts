// EventBridge Scheduled Rule — "cron(5 * * * ? *)" (hourly, :05), Asia/Jerusalem.
// INCORE only. Keeps MembershipItem.status in step with its dates:
//   PENDING whose start has come      → ACTIVE
//   ACTIVE/PENDING past its last day  → EXPIRED (end of that day, Israel time)
// See lib/membershipExpiry.ts for the date rules.
//
// Before this, nothing expired a regular subscription by date: monthEndRollover
// only marks them processed, and billing expires one only when a renewal
// charge succeeds (supersede) or declines. A subscription whose agreement was
// cancelled, a manual one, or a mid_month one stayed ACTIVE indefinitely —
// and checkout then sold the member the NEXT month, as if this month were
// already covered.
//
// An auto-renewing membership with an active billing agreement is left alone
// for up to RENEWAL_GRACE_MS after its end: chargeHypBillingAgreements (03:00
// on the 1st) replaces it on success and expires it on a decline, so it never
// shows as expired between the end of the month and the renewal.
//
// Invoke with {"dryRun": true} to log what it would do without writing.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem } from '../lib/entities';
import { queryOpenAgreementsForMember } from '../lib/hypAgreementQueries';
import { membershipEndsAt, sweepAction, type SweepAction } from '../lib/membershipExpiry';

export async function scanLiveMemberships(): Promise<MembershipItem[]> {
  const out: MembershipItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND #status IN (:active, :pending)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE', ':pending': 'PENDING' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as MembershipItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** Whether the member has an active (not paused/cancelled) subscription agreement that will renew. */
async function makeRenewalLookup(): Promise<(memberId: string) => Promise<boolean>> {
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

/** Decides (and, unless dryRun, applies) the action for every live membership. Shared with scripts/fixMembershipStatuses.ts. */
export async function sweepMemberships(now: Date, dryRun: boolean): Promise<SweepRow[]> {
  const memberships = await scanLiveMemberships();
  const hasActiveRenewal = await makeRenewalLookup();
  const rows: SweepRow[] = [];
  const nowIso = now.toISOString();

  for (const m of memberships) {
    const memberId = m.PK.replace('MEMBER#', '');
    let action = sweepAction(m, now, false);
    // Only an ACTIVE auto-renewing membership past its end needs the agreement lookup.
    if (action === 'expire' && m.status === 'ACTIVE' && m.isAutoRenew === true) {
      action = sweepAction(m, now, await hasActiveRenewal(memberId));
    }
    if (action === 'none') continue;
    rows.push({
      memberId, SK: m.SK, action, status: m.status,
      endsAt: membershipEndsAt(m).toISOString(),
      productName: (m as MembershipItem & { productName?: string }).productName ?? '',
    });
    if (dryRun || action === 'renewal_grace') continue;

    const next = action === 'expire' ? 'EXPIRED' : 'ACTIVE';
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: m.PK, SK: m.SK },
        UpdateExpression: action === 'expire'
          ? 'SET #status = :next, expiredAt = :now, expiredBy = :by, updatedAt = :now'
          : 'SET #status = :next, updatedAt = :now',
        // Only if nothing (a renewal, an admin edit) changed it since the scan.
        ConditionExpression: '#status = :prev',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':next': next, ':now': nowIso, ':prev': m.status,
          ...(action === 'expire' ? { ':by': 'expireMemberships' } : {}),
        },
      }));
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') continue;
      console.error(`[expireMemberships] ${action} failed member=${memberId} SK=${m.SK}`, err);
    }
  }
  return rows;
}

export async function handler(event?: { dryRun?: boolean }): Promise<{ dryRun: boolean; rows: SweepRow[] }> {
  const dryRun = event?.dryRun === true;
  const rows = await sweepMemberships(new Date(), dryRun);
  for (const r of rows) console.log(`[expireMemberships]${dryRun ? ' DRY' : ''} ${r.action} member=${r.memberId} SK=${r.SK} status=${r.status} endsAt=${r.endsAt}`);
  const count = (a: SweepAction) => rows.filter((r) => r.action === a).length;
  console.log(`[expireMemberships]${dryRun ? ' DRY' : ''} expired=${count('expire')} activated=${count('activate')} renewal_grace=${count('renewal_grace')}`);
  return { dryRun, rows };
}
