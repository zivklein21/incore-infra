import type { StartReason } from './rules';

/** One month a freeze touches: how its refund was worked out, and where it is. */
export interface FreezeMonth {
  month: string; // "YYYY-MM"
  /** The freeze's days inside this month. */
  start: string; end: string;
  /** The group's sessions inside the freeze dates, and in the whole month. */
  frozenSessions: number;
  totalSessions: number;
  /** Counted from the recurring schedule because the month's sessions don't exist yet. */
  sessionsEstimated: boolean;
  /** That month's charge, or the subscription amount while it hasn't been charged. */
  monthlyPayment: number;
  paymentEstimated: boolean;
  /** payment x frozen / total. */
  formulaAmount: number;
  /** formula: worked out again from the real numbers when the month's charge comes; fixed: Or's amount. */
  mode: 'formula' | 'fixed';
  amount: number;
  status: 'refunded' | 'manual_pending' | 'waiting_for_charge' | 'no_charge' | 'zero';
  orderId?: string;
  refundId?: string;
  doneAt?: string;
}

export interface FreezeDecision {
  decision: 'approved' | 'rejected';
  decidedBy: { uid: string; name: string };
  decidedAt: string;
  note?: string;
  from?: string;
  to?: string;
  startReason?: StartReason;
  startReasonNote?: string;
  warnings?: string[];
  months?: FreezeMonth[];
}
