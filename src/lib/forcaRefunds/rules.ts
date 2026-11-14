// FORCA refunds (זיכוי חלקי, and later the medical freeze): the pure rules.
// A credit is always an immediate refund against the trainee's most recent
// FORCA subscription charge. The monthly charge never changes; there are no
// offsets and no open credits. Storage and the HYP call are in store.ts.

export const DEFAULT_PRICE_PER_SESSION = 62.5;
export const MAX_REFUND_AMOUNT = 10_000;
export const MAX_PRICE_PER_SESSION = 1_000;

export const REFUND_TYPES = ['partial', 'medical_freeze'] as const;
export type RefundType = typeof REFUND_TYPES[number];

/**
 * processing     the HYP refund is being sent (only stays here if the Lambda died mid-call)
 * refunded       HYP refunded it; refundTransactionId is set
 * manual_pending "להחזיר ידנית ב-HYP": Or still has to refund it in HYP herself
 * manual_done    Or marked the manual refund done
 */
export type RefundStatus = 'processing' | 'refunded' | 'manual_pending' | 'manual_done';

/** Why a refund went to manual. */
export type ManualReason = 'no_charge' | 'no_transaction_id' | 'exceeds_refundable' | 'hyp_declined' | 'hyp_error';

/** Rounds to agorot (2 decimals). */
export const roundMoney = (n: number): number => Math.round(n * 100) / 100;

const hasAtMostTwoDecimals = (n: number) => Math.abs(roundMoney(n) - n) < 1e-9;

export type RefundInput = { amount: number; note: string; type: RefundType };

/** Validates what Or (or the medical freeze) asks to refund. Returns an error code or the clean input. */
export function validateRefundInput(raw: { amount?: unknown; note?: unknown; type?: unknown }): { error: string } | RefundInput {
  const amount = typeof raw.amount === 'number' ? raw.amount : typeof raw.amount === 'string' ? Number(raw.amount) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'invalid_amount' };
  if (!hasAtMostTwoDecimals(amount)) return { error: 'invalid_amount' };
  if (amount > MAX_REFUND_AMOUNT) return { error: 'amount_too_large' };
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length < 2) return { error: 'note_required' };
  if (note.length > 500) return { error: 'note_too_long' };
  const type = raw.type === undefined ? 'partial' : raw.type;
  if (!REFUND_TYPES.includes(type as RefundType)) return { error: 'invalid_type' };
  return { amount: roundMoney(amount), note, type: type as RefundType };
}

export function validatePricePerSession(raw: unknown): number | null {
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(v) || v <= 0 || v > MAX_PRICE_PER_SESSION || !hasAtMostTwoDecimals(v)) return null;
  return roundMoney(v);
}

/** Every "YYYY-MM-DD" from `today` to the last day of its month, inclusive. */
export function daysToMonthEnd(today: string): string[] {
  const [y, m, d] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let day = d; day <= last; day++) out.push(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  return out;
}

/**
 * The group's sessions still to come this month: same group, starting after
 * `now`. A session already started or done today doesn't count. Cancelled
 * sessions are deleted, so they're never in the list.
 */
export function countRemainingSessions(sessions: { date?: string; groupId?: string }[], groupId: string, now: Date): number {
  const t = now.getTime();
  return sessions.filter((s) => s.groupId === groupId && !!s.date && new Date(s.date).getTime() > t).length;
}

export type Suggestion = { sessions: number; pricePerSession: number; amount: number };

/** The hint next to the amount: X sessions left × price per session. Never applied by itself. */
export function suggestRefund(sessions: number, pricePerSession: number): Suggestion {
  return { sessions, pricePerSession, amount: roundMoney(sessions * pricePerSession) };
}

export type ChargeForRefund = { amount: number; refundedTotal?: number; hypTransactionId?: string } | null;

/** What can still be refunded from a charge. */
export function refundableOf(order: ChargeForRefund): number {
  if (!order) return 0;
  return Math.max(0, roundMoney(order.amount - (order.refundedTotal ?? 0)));
}

/** Whether a refund of `amount` can go to HYP, or must be done by hand (and why). */
export function decideRefund(amount: number, order: ChargeForRefund): { kind: 'hyp' } | { kind: 'manual'; reason: ManualReason } {
  if (!order) return { kind: 'manual', reason: 'no_charge' };
  if (!order.hypTransactionId) return { kind: 'manual', reason: 'no_transaction_id' };
  if (amount > refundableOf(order) + 1e-9) return { kind: 'manual', reason: 'exceeds_refundable' };
  return { kind: 'hyp' };
}
