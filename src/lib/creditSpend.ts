import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TABLE_NAME } from './dynamo';
import { israelDateStr, monthKey, type PunchCardItem, type WalletItem } from './entities';
import { addCreditItem, walletKey } from './walletCredit';

// Which credit pays for a class, and where a refunded credit goes back to.
// Shared by bookClass.ts, adminAddToClass.ts and confirmWaitlistSpot.ts
// (spending) and cancelBooking.ts / adminCancelRegistration.ts /
// onClassDeleted.ts / adminRemoveLegalCancellation.ts /
// adminRevertLateCancellation.ts (refunds).
//
// Candidates are the wallet's month batches (creditBuckets: earned in month
// M, valid through the last day of M+1), untracked legacy wallet credit (no
// expiry), and the member's punch cards (manual/admin, store, birthday — each
// with its own optional expiryDate). Rules:
//   1. Only credit still valid on the CLASS date counts (a batch/card that
//      will have lapsed by then can't pay for it) — same rule punch cards
//      always had.
//   2. Soonest expiry first; tie → earned first; no expiry → last.
//   3. Nothing valid but something lapsed → 'credits_expired' (not
//      'no_credits'), so the member is told why.

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** creditBucket value recorded on a registration paid from untracked (pre-tracking) wallet credit. */
export const UNTRACKED_BUCKET = 'untracked';

export const CREDITS_EXPIRED_MESSAGE = 'הקרדיטים שלך פגו תוקף';

/** Last valid day ('YYYY-MM-DD') of credit earned in `month` ('YYYY-MM'): the last day of the following month. */
export function bucketExpiresOn(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const lastDay = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
  return `${nextY}-${String(nextM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export type CreditChoice =
  | { consumedFrom: 'EXTRA_PUNCH'; creditBucket: string } // a 'YYYY-MM' month or UNTRACKED_BUCKET
  | { consumedFrom: 'ADMIN_CARD'; adminCardId: string }
  | { error: 'no_credits' | 'credits_expired' | 'card_unavailable' };

interface Candidate {
  choice: Exclude<CreditChoice, { error: string }>;
  expiresOn: string | null; // 'YYYY-MM-DD' (Israel date) or null = never
  earned: string;           // sortable; '' when unknown
}

const byExpiryThenEarned = (a: Candidate, b: Candidate) => {
  if (a.expiresOn !== b.expiresOn) {
    if (a.expiresOn === null) return 1;
    if (b.expiresOn === null) return -1;
    return a.expiresOn.localeCompare(b.expiresOn);
  }
  return a.earned.localeCompare(b.earned);
};

function walletCandidates(wallet: WalletItem | undefined, classDay: string): { valid: Candidate[]; hasLapsed: boolean } {
  const balance = Math.max(0, wallet?.extraPunches ?? 0);
  const buckets = Object.entries(wallet?.creditBuckets ?? {}).filter(([, n]) => n > 0);
  const tracked = buckets.reduce((sum, [, n]) => sum + n, 0);
  const valid: Candidate[] = [];
  let hasLapsed = false;
  if (balance <= 0) return { valid, hasLapsed };
  for (const [month] of buckets) {
    const expiresOn = bucketExpiresOn(month);
    if (expiresOn < classDay) { hasLapsed = true; continue; }
    valid.push({ choice: { consumedFrom: 'EXTRA_PUNCH', creditBucket: month }, expiresOn, earned: `${month}-01` });
  }
  if (balance - tracked > 0) {
    valid.push({ choice: { consumedFrom: 'EXTRA_PUNCH', creditBucket: UNTRACKED_BUCKET }, expiresOn: null, earned: '' });
  }
  return { valid, hasLapsed };
}

function cardCandidates(cards: PunchCardItem[], classDate: Date): { valid: Candidate[]; hasLapsed: boolean } {
  const valid: Candidate[] = [];
  let hasLapsed = false;
  for (const card of cards) {
    if ((card.remainingPunches ?? 0) <= 0) continue;
    if (card.expiryDate && new Date(card.expiryDate) < classDate) { hasLapsed = true; continue; }
    const raw = card as PunchCardItem & { createdAt?: string; purchasedAt?: string };
    valid.push({
      choice: { consumedFrom: 'ADMIN_CARD', adminCardId: card.cardId },
      expiresOn: card.expiryDate ? israelDateStr(new Date(card.expiryDate)) : null,
      earned: raw.createdAt ?? raw.purchasedAt ?? '',
    });
  }
  return { valid, hasLapsed };
}

/**
 * The credit that pays for a class on `classDate`.
 * `walletCardId`: the member's explicit pick — 'extra_punch' (wallet, best
 * batch within it) or a punch card id; null = best of everything.
 * `allowWallet: false` excludes wallet credit (callers that never spend it).
 */
export function chooseCredit(
  wallet: WalletItem | undefined,
  cards: PunchCardItem[],
  classDate: Date,
  opts: { walletCardId?: string | null; allowWallet?: boolean } = {},
): CreditChoice {
  const classDay = israelDateStr(classDate);
  const allowWallet = opts.allowWallet !== false;
  const w = allowWallet ? walletCandidates(wallet, classDay) : { valid: [], hasLapsed: false };
  const c = cardCandidates(cards, classDate);

  let pool: Candidate[];
  let lapsed: boolean;
  if (opts.walletCardId === 'extra_punch') {
    if (!allowWallet) return { error: 'card_unavailable' };
    pool = w.valid; lapsed = w.hasLapsed;
  } else if (opts.walletCardId) {
    const card = cards.find((x) => x.cardId === opts.walletCardId);
    if (!card || (card.remainingPunches ?? 0) <= 0) return { error: 'card_unavailable' };
    pool = c.valid.filter((x) => x.choice.consumedFrom === 'ADMIN_CARD' && x.choice.adminCardId === card.cardId);
    lapsed = pool.length === 0;
  } else {
    pool = [...w.valid, ...c.valid]; lapsed = w.hasLapsed || c.hasLapsed;
  }

  const best = [...pool].sort(byExpiryThenEarned)[0];
  if (best) return best.choice;
  return { error: lapsed ? 'credits_expired' : 'no_credits' };
}

/** Transaction item spending one wallet credit from `creditBucket` (a month, or UNTRACKED_BUCKET). */
export function spendFromBucketItem(uid: string, wallet: WalletItem | undefined, creditBucket: string, nowIso: string): TransactItem {
  if (creditBucket === UNTRACKED_BUCKET) {
    // Untracked = balance beyond what the buckets account for; the condition
    // keeps it from dipping into (expiring) tracked credit.
    const tracked = Object.values(wallet?.creditBuckets ?? {}).reduce((sum, n) => sum + Math.max(0, n), 0);
    return {
      Update: {
        TableName: TABLE_NAME,
        Key: walletKey(uid),
        UpdateExpression: 'ADD extraPunches :negOne SET updatedAt = :now',
        ConditionExpression: 'extraPunches > :tracked',
        ExpressionAttributeValues: { ':negOne': -1, ':tracked': tracked, ':now': nowIso },
      },
    };
  }
  return {
    Update: {
      TableName: TABLE_NAME,
      Key: walletKey(uid),
      UpdateExpression: 'ADD extraPunches :negOne, creditBuckets.#m :negOne SET updatedAt = :now',
      ConditionExpression: 'extraPunches > :zero AND creditBuckets.#m > :zero',
      ExpressionAttributeNames: { '#m': creditBucket },
      ExpressionAttributeValues: { ':negOne': -1, ':zero': 0, ':now': nowIso },
    },
  };
}

/**
 * Where a refunded wallet credit goes: back to the batch it was spent from,
 * keeping that batch's expiry — or, when that batch has already lapsed (or
 * the booking predates creditBucket being recorded), to the current month.
 * Returns the bucket to credit, or UNTRACKED_BUCKET.
 */
export function refundBucket(creditBucket: string | null | undefined, now: Date = new Date()): string {
  if (creditBucket === UNTRACKED_BUCKET) return UNTRACKED_BUCKET;
  if (creditBucket && /^\d{4}-\d{2}$/.test(creditBucket) && bucketExpiresOn(creditBucket) >= israelDateStr(now)) {
    return creditBucket;
  }
  return monthKey(now);
}

/** Transaction item refunding one wallet credit (see refundBucket). Call ensureCreditBuckets(uid) first. */
export function refundCreditItem(uid: string, creditBucket: string | null | undefined, nowIso: string, now: Date = new Date()): TransactItem {
  const target = refundBucket(creditBucket, now);
  if (target === UNTRACKED_BUCKET) {
    return {
      Update: {
        TableName: TABLE_NAME,
        Key: walletKey(uid),
        UpdateExpression: 'ADD extraPunches :one SET updatedAt = :now',
        ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
      },
    };
  }
  return addCreditItem(uid, 1, nowIso, target);
}
