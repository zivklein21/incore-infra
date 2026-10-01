import { UpdateCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { monthKey, type WalletItem } from './entities';

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

// Transaction item that spends one credit — from the oldest non-empty month
// bucket when there is one (untracked legacy credit otherwise). Fails the
// transaction (ConditionalCheckFailed) when the wallet is empty.
export function spendCreditItem(uid: string, wallet: WalletItem | undefined, nowIso: string): TransactItem {
  const oldest = Object.entries(wallet?.creditBuckets ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))[0]?.[0];
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: walletKey(uid),
      UpdateExpression: oldest
        ? 'ADD extraPunches :negOne, creditBuckets.#m :negOne SET updatedAt = :now'
        : 'ADD extraPunches :negOne SET updatedAt = :now',
      ConditionExpression: oldest
        ? 'extraPunches > :zero AND creditBuckets.#m > :zero'
        : 'extraPunches > :zero',
      ...(oldest ? { ExpressionAttributeNames: { '#m': oldest } } : {}),
      ExpressionAttributeValues: { ':negOne': -1, ':zero': 0, ':now': nowIso },
    },
  };
}

// Buckets that have lapsed as of `now`: earned before last month.
export function expiredBuckets(wallet: WalletItem, now: Date = new Date()): Record<string, number> {
  const cutoff = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  return Object.fromEntries(
    Object.entries(wallet.creditBuckets ?? {}).filter(([m, n]) => m < cutoff && n > 0),
  );
}

// For display: the wallet's credit grouped by expiry, soonest first. Credit
// earned in month M is valid through the last day of month M+1 — returned as
// a plain 'YYYY-MM-DD' date (no time zone to shift it). Credit that predates
// creditBuckets (sum < extraPunches) is listed with expiresOn null.
export function creditExpiries(wallet: WalletItem | undefined): { amount: number; expiresOn: string | null }[] {
  if (!wallet) return [];
  const out: { amount: number; expiresOn: string | null }[] = Object.entries(wallet.creditBuckets ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, n]) => {
      const [y, mo] = m.split('-').map(Number);
      const nextY = mo === 12 ? y + 1 : y;
      const nextM = mo === 12 ? 1 : mo + 1;
      const lastDay = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate(); // day 0 of the month after = last day of nextM
      return { amount: n, expiresOn: `${nextY}-${String(nextM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
    });
  const tracked = out.reduce((sum, e) => sum + e.amount, 0);
  const untracked = (wallet.extraPunches ?? 0) - tracked;
  if (untracked > 0) out.push({ amount: untracked, expiresOn: null });
  return out;
}
