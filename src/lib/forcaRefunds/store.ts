import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import type { ForcaSubscriptionOrderItem } from '../entities';
import { refundHypTransaction } from '../hypClient';
import { israelDateStrOf } from '../israelTime';
import {
  DEFAULT_PRICE_PER_SESSION, countRemainingSessions, daysToMonthEnd, decideRefund, refundableOf, roundMoney, suggestRefund,
  type ManualReason, type RefundStatus, type RefundType, type Suggestion,
} from './rules';

// FORCA refunds: the record of every refund, the price-per-session setting,
// and issueForcaRefund() — the one way money goes back to a FORCA parent for
// a subscription. Used by Or's "זיכוי חלקי" (type 'partial') and, later, the
// medical freeze (type 'medical_freeze', with its own calculated amount).
//
// Storage (FORCA table):
//   PK=FORCAREFUND#<id> SK=METADATA
//   GSI1PK=MEMBER#<traineeId> GSI1SK=FORCAREFUND#<createdAt>#<id>   one trainee's refunds
//   GSI2PK=FORCAREFUND        GSI2SK=<createdAt>#<id>               every refund (the list screen)
// The charge refunded keeps a running `refundedTotal`, so the total refunded
// never goes past what was charged, even with two refunds at once.

export const SETTINGS_KEY = { PK: 'APPCONFIG', SK: 'FORCA_REFUND_SETTINGS' } as const;

export type RefundBy = { uid: string; name: string };

export interface ForcaRefundItem {
  PK: string; SK: 'METADATA';
  GSI1PK: string; GSI1SK: string;
  GSI2PK: 'FORCAREFUND'; GSI2SK: string;
  refundId: string;
  traineeId: string;
  agreementId?: string;
  type: RefundType;
  amount: number;
  note: string;
  status: RefundStatus;
  createdBy: RefundBy;
  createdAt: string;
  updatedAt: string;
  /** The charge refunded (or that was checked, for a manual one). */
  orderId?: string;
  orderAmount?: number;
  /** What could still be refunded from that charge when this was asked. */
  refundableAtRequest: number;
  hypTransactionId?: string;
  refundTransactionId?: string;
  hypCCode?: number;
  manualReason?: ManualReason;
  manualDoneBy?: RefundBy;
  manualDoneAt?: string;
  /** Free-form context from the caller (e.g. the medical freeze's dates). */
  details?: Record<string, unknown>;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function loadPricePerSession(): Promise<number> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: SETTINGS_KEY }));
  const v = (res.Item as { pricePerSession?: unknown } | undefined)?.pricePerSession;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_PRICE_PER_SESSION;
}

export async function savePricePerSession(pricePerSession: number, by: RefundBy): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: { ...SETTINGS_KEY, pricePerSession, updatedAt: new Date().toISOString(), updatedBy: by },
  }));
}

// ─── Suggestion ─────────────────────────────────────────────────────────────

/** The group's sessions from now to the end of this month (Israel time), one Query per day. */
export async function countGroupSessionsToMonthEnd(groupId: string, now: Date): Promise<number> {
  const days = daysToMonthEnd(israelDateStrOf(now));
  const results = await Promise.all(days.map((day) => ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    FilterExpression: 'groupId = :g',
    ExpressionAttributeValues: { ':pk': `CLASSDATE#${day}`, ':g': groupId },
  }))));
  const sessions = results.flatMap((r) => (r.Items ?? []) as { date?: string; groupId?: string }[]);
  return countRemainingSessions(sessions, groupId, now);
}

export async function buildSuggestion(groupId: string | null, now: Date): Promise<Suggestion & { groupId: string | null }> {
  const price = await loadPricePerSession();
  const sessions = groupId ? await countGroupSessionsToMonthEnd(groupId, now) : 0;
  return { ...suggestRefund(sessions, price), groupId };
}

// ─── The charge to refund ───────────────────────────────────────────────────

/** The trainee's most recent completed FORCA subscription charge (sign-up or monthly), or null. */
export async function latestSubscriptionCharge(traineeId: string): Promise<ForcaSubscriptionOrderItem & { refundedTotal?: number } | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${traineeId}`, ':prefix': 'FORCASUBORDER#' },
    ScanIndexForward: false,
    Limit: 25,
  }));
  const orders = (res.Items ?? []) as (ForcaSubscriptionOrderItem & { refundedTotal?: number })[];
  return orders.find((o) => o.status === 'completed' && typeof o.amount === 'number' && o.amount > 0) ?? null;
}

export function chargeSummary(order: (ForcaSubscriptionOrderItem & { refundedTotal?: number }) | null) {
  if (!order) return null;
  return {
    orderId: order.orderId,
    amount: order.amount,
    refundedTotal: order.refundedTotal ?? 0,
    refundable: refundableOf(order),
    createdAt: order.createdAt,
    productName: order.productName,
    hasTransactionId: !!order.hypTransactionId,
  };
}

// ─── Records ────────────────────────────────────────────────────────────────

export async function listTraineeRefunds(traineeId: string): Promise<ForcaRefundItem[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${traineeId}`, ':prefix': 'FORCAREFUND#' },
    ScanIndexForward: false,
  }));
  return (res.Items ?? []) as ForcaRefundItem[];
}

export async function listAllRefunds(): Promise<ForcaRefundItem[]> {
  const out: ForcaRefundItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'FORCAREFUND' },
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as ForcaRefundItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function updateRecord(refundId: string, fields: Record<string, unknown>): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = Object.entries(fields).map(([k, v], i) => { names[`#f${i}`] = k; values[`:v${i}`] = v; return `#f${i} = :v${i}`; });
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `FORCAREFUND#${refundId}`, SK: 'METADATA' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

/** Moves the charge's refundedTotal from `from` to `to`, only if nobody changed it in between. */
async function moveRefundedTotal(order: { PK: string; SK: string }, from: number, to: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: order.PK, SK: order.SK },
    UpdateExpression: 'SET refundedTotal = :to',
    ConditionExpression: from === 0 ? 'attribute_not_exists(refundedTotal) OR refundedTotal = :from' : 'refundedTotal = :from',
    ExpressionAttributeValues: { ':to': to, ':from': from },
  }));
}

export class RefundConflictError extends Error {
  constructor() { super('refund_conflict'); this.name = 'RefundConflictError'; }
}

export type IssueRefundParams = {
  traineeId: string;
  amount: number;
  note: string;
  type: RefundType;
  by: RefundBy;
  agreementId?: string;
  details?: Record<string, unknown>;
};

/**
 * Refunds `amount` against the trainee's most recent FORCA subscription charge
 * through HYP (the same zikoyAPI refund INCORE uses), up to what wasn't
 * refunded from it yet. If there's no such charge, the amount is more than
 * can be refunded, or HYP refuses, nothing is sent (or nothing went through)
 * and the record says "להחזיר ידנית ב-HYP" (manual_pending) for Or to finish
 * and mark done. Always returns the saved record. Throws RefundConflictError
 * if another refund on the same charge was saved at the same moment (nothing
 * is sent then; try again).
 */
export async function issueForcaRefund(p: IssueRefundParams): Promise<ForcaRefundItem> {
  const order = await latestSubscriptionCharge(p.traineeId);
  const refundable = refundableOf(order);
  const decision = decideRefund(p.amount, order);

  const refundId = randomUUID();
  const nowIso = new Date().toISOString();
  const record: ForcaRefundItem = {
    PK: `FORCAREFUND#${refundId}`, SK: 'METADATA',
    GSI1PK: `MEMBER#${p.traineeId}`, GSI1SK: `FORCAREFUND#${nowIso}#${refundId}`,
    GSI2PK: 'FORCAREFUND', GSI2SK: `${nowIso}#${refundId}`,
    refundId,
    traineeId: p.traineeId,
    ...(p.agreementId ? { agreementId: p.agreementId } : {}),
    type: p.type,
    amount: roundMoney(p.amount),
    note: p.note,
    status: decision.kind === 'hyp' ? 'processing' : 'manual_pending',
    createdBy: p.by,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(order ? { orderId: order.orderId, orderAmount: order.amount } : {}),
    ...(order?.hypTransactionId ? { hypTransactionId: order.hypTransactionId } : {}),
    refundableAtRequest: refundable,
    ...(decision.kind === 'manual' ? { manualReason: decision.reason } : {}),
    ...(p.details ? { details: p.details } : {}),
  };

  if (decision.kind === 'manual' || !order) {
    await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: record, ConditionExpression: 'attribute_not_exists(PK)' }));
    console.log(`[forcaRefund] ${refundId} trainee=${p.traineeId} ₪${record.amount} → manual (${record.manualReason})`);
    return record;
  }

  // Count the amount on the charge before sending, so two refunds at once
  // can't both pass the limit. If HYP then refuses, it's taken back off.
  const before = order.refundedTotal ?? 0;
  const after = roundMoney(before + record.amount);
  try {
    await moveRefundedTotal(order, before, after);
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') throw new RefundConflictError();
    throw err;
  }
  // From here a "processing" record exists, so a Lambda that dies mid-call
  // still leaves a trace Or can see and check in HYP.
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: record, ConditionExpression: 'attribute_not_exists(PK)' }));

  let result: { success: boolean; ccode: number; refundTransactionId?: string };
  try {
    result = await refundHypTransaction(order.hypTransactionId!, record.amount);
  } catch (err) {
    console.error(`[forcaRefund] ${refundId} HYP refund threw:`, err);
    result = { success: false, ccode: -1 };
  }

  const doneIso = new Date().toISOString();
  if (result.success) {
    const fields = { status: 'refunded' as const, hypCCode: result.ccode, updatedAt: doneIso, ...(result.refundTransactionId ? { refundTransactionId: result.refundTransactionId } : {}) };
    await updateRecord(refundId, fields);
    console.log(`[forcaRefund] ${refundId} trainee=${p.traineeId} order=${order.orderId} ₪${record.amount} refunded (${result.refundTransactionId ?? 'no id'})`);
    return { ...record, ...fields };
  }

  try {
    await moveRefundedTotal(order, after, before);
  } catch (err) {
    // Leaves the charge's total too high, which only ever blocks a refund, never allows an extra one.
    console.error(`[forcaRefund] ${refundId} could not take ₪${record.amount} back off order ${order.orderId}:`, err);
  }
  const reason: ManualReason = result.ccode === -1 ? 'hyp_error' : 'hyp_declined';
  const fields = { status: 'manual_pending' as const, manualReason: reason, hypCCode: result.ccode, updatedAt: doneIso };
  await updateRecord(refundId, fields);
  console.warn(`[forcaRefund] ${refundId} trainee=${p.traineeId} order=${order.orderId} ₪${record.amount} HYP refused (ccode ${result.ccode}) → manual`);
  return { ...record, ...fields };
}

export async function loadRefund(refundId: string): Promise<ForcaRefundItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCAREFUND#${refundId}`, SK: 'METADATA' } }));
  return (res.Item as ForcaRefundItem | undefined) ?? null;
}

/** Or refunded it in HYP herself. Allowed from manual_pending, or from a "processing" left behind. */
export async function markManualRefundDone(refundId: string, by: RefundBy): Promise<ForcaRefundItem | null> {
  const nowIso = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `FORCAREFUND#${refundId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :done, manualDoneBy = :by, manualDoneAt = :now, updatedAt = :now',
      ConditionExpression: '#status IN (:pending, :processing)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':done': 'manual_done', ':by': by, ':now': nowIso, ':pending': 'manual_pending', ':processing': 'processing' },
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
  return loadRefund(refundId);
}
