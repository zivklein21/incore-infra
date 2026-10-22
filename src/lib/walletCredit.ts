import { UpdateCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { israelDateStr, monthKey, type WalletItem } from './entities';

// Wallet credit (extraPunches) with a one-month expiry, per the terms of
// service: credit earned in month M is valid until the end of month M+1.
// Alongside the extraPunches total, WALLET#PRIMARY keeps creditBuckets —
// how much of it was earned in each month — so expireWalletCredits.ts can
// remove exactly what has lapsed. Adds go to the current month's bucket;
// spends come out of the oldest bucket first.

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export const walletKey = (uid: string) => ({ PK: `MEMBER#${uid}`, SK: 'WALLET#PRIMARY' });

// ADD on creditBuckets.<month> needs the map to exist already, and a single
// update can't both create the map and ADD into it — so this runs first, on
// its own (idempotent; also creates the wallet item if it doesn't exist).
export async function ensureCreditBuckets(uid: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: walletKey(uid),
    UpdateExpression: 'SET creditBuckets = if_not_exists(creditBuckets, :empty)',
    ExpressionAttributeValues: { ':empty': {} },
  }));
}

// Transaction item that adds `amount` credit earned in `month`. Call
// ensureCreditBuckets(uid) before sending the transaction.
export function addCreditItem(uid: string, amount: number, nowIso: string, month: string = monthKey(new Date())): TransactItem {
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: walletKey(uid),
      UpdateExpression: 'ADD extraPunches :n, creditBuckets.#m :n SET updatedAt = :now',
      ExpressionAttributeNames: { '#m': month },
      ExpressionAttributeValues: { ':n': amount, ':now': nowIso },
    },
  };
}

// Spending (soonest-expiring valid batch, lapsed skipped) lives in
// lib/creditSpend.ts (chooseCredit / spendFromBucketItem).

// Launch grace period: everything earned up to and including Nov 2026
// (weekly runs, admin edits, refunds — anything that lands in a bucket
// month <= GRACE_LAST_EARNED_MONTH) stays valid until Dec 31, 2026. From Dec
// 2026 on, the terms-of-service rule: valid through the last day of the
// month after the one it was earned in. The single source of truth for a
// bucket's expiry — spending (creditSpend.ts), refunds, the expiry job and
// getWallet's creditExpiries all use it.
export const GRACE_LAST_EARNED_MONTH = '2026-11';
export const GRACE_EXPIRES_ON = '2026-12-31';

/** Last valid day ('YYYY-MM-DD', Israel date) of credit earned in `month` ('YYYY-MM'). */
export function bucketExpiresOn(month: string): string {
  if (month <= GRACE_LAST_EARNED_MONTH) return GRACE_EXPIRES_ON;
  const [y, m] = month.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const lastDay = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
  return `${nextY}-${String(nextM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// Buckets that have lapsed as of `now`: their last valid day is before today (Israel date).
export function expiredBuckets(wallet: WalletItem, now: Date = new Date()): Record<string, number> {
  const today = israelDateStr(now);
  return Object.fromEntries(
    Object.entries(wallet.creditBuckets ?? {}).filter(([m, n]) => n > 0 && bucketExpiresOn(m) < today),
  );
}

// For display: the wallet's credit grouped by expiry date, soonest first —
// batches sharing an expiry date (e.g. everything under the grace period)
// are merged into one entry. Credit that predates creditBuckets
// (sum < extraPunches) is listed with expiresOn null.
export function creditExpiries(wallet: WalletItem | undefined): { amount: number; expiresOn: string | null }[] {
  if (!wallet) return [];
  const byDate = new Map<string, number>();
  for (const [m, n] of Object.entries(wallet.creditBuckets ?? {})) {
    if (n <= 0) continue;
    const date = bucketExpiresOn(m);
    byDate.set(date, (byDate.get(date) ?? 0) + n);
  }
  const out: { amount: number; expiresOn: string | null }[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([expiresOn, amount]) => ({ amount, expiresOn }));
  const tracked = out.reduce((sum, e) => sum + e.amount, 0);
  const untracked = (wallet.extraPunches ?? 0) - tracked;
  if (untracked > 0) out.push({ amount: untracked, expiresOn: null });
  return out;
}

// An admin setting a member's balance by hand (adminUpdateMemberWallet.ts).
// Existing batches keep their own expiry: an increase goes into `month`'s
// bucket; a decrease comes out of the oldest (soonest-to-expire, lapsed
// first) buckets, then out of untracked legacy credit. Buckets are also
// trimmed (oldest first) so they never add up to more than the new balance —
// which repairs a wallet whose buckets drifted from extraPunches.
export function adjustCreditBuckets(
  buckets: Record<string, number> | undefined,
  oldBalance: number,
  newBalance: number,
  month: string,
): Record<string, number> {
  if (newBalance <= 0) return {};
  const out: Record<string, number> = Object.fromEntries(
    Object.entries(buckets ?? {}).filter(([, n]) => n > 0),
  );
  const delta = newBalance - oldBalance;
  if (delta > 0) out[month] = (out[month] ?? 0) + delta;
  const takeOldest = (amount: number) => {
    for (const m of Object.keys(out).sort()) {
      if (amount <= 0) break;
      const take = Math.min(out[m], amount);
      out[m] -= take;
      amount -= take;
      if (out[m] === 0) delete out[m];
    }
  };
  if (delta < 0) {
    // Tracked (expiring) credit goes first; untracked never expires, so it's kept longest.
    const tracked = Object.values(out).reduce((sum, n) => sum + n, 0);
    takeOldest(Math.min(-delta, tracked));
  }
  const total = Object.values(out).reduce((sum, n) => sum + n, 0);
  if (total > newBalance) takeOldest(total - newBalance);
  return out;
}
