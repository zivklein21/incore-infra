import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { getUid, json } from './http';
import { isAdmin } from './auth';
import { monthKey, type HypOrderItem, type MembershipItem } from './entities';
import { adminIdentity, auditEntry, type ManualLogEntry } from './membershipAudit';
import { queryFutureSubscriptionRegistrations } from './membershipQueries';

// INCORE admin: a member's subscriptions (MembershipItem), managed by hand.
// For when a payment went through but no subscription was created, or one
// was created wrong. Three routes on incoreWorkoutApi.ts's shared
// integration (300-integration cap): adminListMemberSubscriptions,
// adminSaveMemberSubscription (create, duplicate, edit),
// adminCancelMemberSubscription. Admin only.
//
// What this adds to the MembershipItem, all optional, so every existing
// reader ignores it:
//   totalAmount        what the subscription cost (₪), as the admin entered it
//   paymentOrderId     the HYP order the admin linked it to
//   isManual           created or edited here
//   manualLog[]        who did what, when
//   cancelledAt/By     set by cancel (status CANCELLED)
//
// Subscriptions the payment flow created carry no link to their order. The
// list matches one by member + month (+ product when both have it) and labels
// it "matched", so the admin can tell an inferred link from one they set.
//
// Status follows the dates: ended → EXPIRED, not started → PENDING
// (activatePendingMemberships flips it on its start date), otherwise ACTIVE.
// A subscription that comes out ACTIVE or PENDING replaces (expires, with
// supersededBy) any other live one whose dates overlap it, in the same
// transaction, so the member never holds two live ones for the same days.
// A backfill for a past month therefore leaves the current one alone.

const LIVE = new Set(['ACTIVE', 'PENDING']);
const MAX_TRANSACT = 100;

type Sub = MembershipItem & {
  productId?: string;
  productName?: string;
  createdAt?: string;
  updatedAt?: string;
  totalAmount?: number;
  paymentOrderId?: string;
  isManual?: boolean;
  isManuallyCreated?: boolean;
  manualLog?: ManualLogEntry[];
  supersededBy?: string;
  cancelledAt?: string;
  cancelledBy?: { uid: string; name: string };
  cancelReason?: string;
  price?: number;
};

export type { ManualLogEntry } from './membershipAudit';

export interface SubscriptionWarning {
  code: 'overlap_same_plan' | 'payment_already_linked' | 'replaces_live' | 'month_later_than_bookings';
  message: string;
  membershipId?: string;
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────

/** A subscription's window. Older items without dates fall back to their calendar month. */
export function windowOf(m: { startDate?: string; endDate?: string; targetMonth: string }): { start: number; end: number } {
  const [y, mo] = m.targetMonth.split('-').map(Number);
  const start = m.startDate ? new Date(m.startDate).getTime() : Date.UTC(y, mo - 1, 1) - 3 * 3600_000;
  const end = m.endDate ? new Date(m.endDate).getTime() : Date.UTC(y, mo, 1) - 3 * 3600_000 - 1;
  return { start, end };
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function statusForWindow(w: { start: number; end: number }, now: number): 'ACTIVE' | 'PENDING' | 'EXPIRED' {
  if (w.end < now) return 'EXPIRED';
  if (w.start > now) return 'PENDING';
  return 'ACTIVE';
}

export function samePlan(a: { productId?: string; productName?: string }, b: { productId?: string; productName?: string }): boolean {
  if (a.productId && b.productId) return a.productId === b.productId;
  const an = (a.productName ?? '').trim().toLowerCase();
  const bn = (b.productName ?? '').trim().toLowerCase();
  return !!an && an === bn;
}

type OrderLite = Pick<HypOrderItem, 'orderId' | 'status' | 'createdAt' | 'amount' | 'productId' | 'productName' | 'productType' | 'targetMonth'>;

export function orderMonth(o: Pick<OrderLite, 'targetMonth' | 'createdAt'>): string {
  return o.targetMonth || monthKey(new Date(o.createdAt));
}

/**
 * Which order each subscription is linked to: the admin's explicit link
 * first, then a best-effort match (same month, same product when both have
 * one, completed, not linked or matched to anything else). Cancelled
 * subscriptions keep their explicit link for the record but never claim a
 * match, and never count as "using" a payment.
 */
export function resolvePaymentLinks(subs: Sub[], orders: OrderLite[]): Map<string, { orderId: string; kind: 'linked' | 'matched' }> {
  const out = new Map<string, { orderId: string; kind: 'linked' | 'matched' }>();
  const orderIds = new Set(orders.map((o) => o.orderId));
  const claimed = new Set<string>();
  for (const s of subs) {
    if (s.paymentOrderId && orderIds.has(s.paymentOrderId)) {
      out.set(s.membershipId, { orderId: s.paymentOrderId, kind: 'linked' });
      if (s.status !== 'CANCELLED') claimed.add(s.paymentOrderId);
    }
  }
  const candidates = orders
    .filter((o) => o.status === 'completed' && (o.productType === 'subscription' || o.productType === 'mid_month'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const unlinked = subs
    .filter((s) => !s.paymentOrderId && s.status !== 'CANCELLED' && !s.isManuallyCreated && s.type !== 'CUSTOM_MIGRATION')
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  for (const s of unlinked) {
    const match = candidates.find((o) => !claimed.has(o.orderId)
      && orderMonth(o) === s.targetMonth
      && (!o.productId || !s.productId || o.productId === s.productId));
    if (match) {
      claimed.add(match.orderId);
      out.set(s.membershipId, { orderId: match.orderId, kind: 'matched' });
    }
  }
  return out;
}

// ── Data access ──────────────────────────────────────────────────────────

async function querySubs(memberId: string): Promise<Sub[]> {
  const out: Sub[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#' },
      ConsistentRead: true,
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as Sub[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function queryOrders(memberId: string): Promise<(HypOrderItem)[]> {
  const out: HypOrderItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'ORDER#' },
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as HypOrderItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  // Card-update verifications and abandoned checkouts aren't payments.
  return out.filter((o) => !o.isCardUpdateOnly && (o.status === 'completed' || o.status === 'refunded'));
}


function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> | null {
  try {
    const b = JSON.parse(event.body ?? '{}');
    return b && typeof b === 'object' ? b as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null);

function toRow(s: Sub, link: { orderId: string; kind: 'linked' | 'matched' } | undefined, ordersById: Map<string, HypOrderItem>) {
  const order = link ? ordersById.get(link.orderId) : undefined;
  const w = windowOf(s);
  return {
    membershipId: s.membershipId,
    targetMonth: s.targetMonth,
    status: s.status,
    productId: s.productId ?? null,
    productName: s.productName ?? '',
    type: s.type ?? null,
    startDate: new Date(w.start).toISOString(),
    endDate: new Date(w.end).toISOString(),
    totalAmount: typeof s.totalAmount === 'number' ? s.totalAmount : (order?.amount ?? null),
    monthlyLimit: s.monthlyLimit,
    weeklyLimit: s.weeklyLimit,
    allowedLegalCancellationsPerMonth: s.allowedLegalCancellationsPerMonth ?? 2,
    isAutoRenew: s.isAutoRenew === true,
    totalMonthlyUsed: s.usage?.totalMonthlyUsed ?? 0,
    isManual: s.isManual === true || s.isManuallyCreated === true,
    manualLog: s.manualLog ?? [],
    supersededBy: s.supersededBy ?? null,
    cancelledAt: s.cancelledAt ?? null,
    cancelledBy: s.cancelledBy ?? null,
    createdAt: s.createdAt ?? null,
    updatedAt: s.updatedAt ?? null,
    payment: link && order ? {
      orderId: order.orderId, kind: link.kind, amount: order.amount, createdAt: order.createdAt,
      productName: order.productName, status: order.status,
    } : null,
  };
}

function sortSubsDesc<T extends { targetMonth: string; startDate: string; createdAt: string | null }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.targetMonth.localeCompare(a.targetMonth)
    || b.startDate.localeCompare(a.startDate)
    || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

// ── GET /adminListMemberSubscriptions?memberId=xxx ───────────────────────

export async function adminListMemberSubscriptions(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const memberId = str(event.queryStringParameters?.memberId);
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const [subs, orders] = await Promise.all([querySubs(memberId), queryOrders(memberId)]);
  const links = resolvePaymentLinks(subs, orders);
  const ordersById = new Map(orders.map((o) => [o.orderId, o]));
  const usedBy = new Map<string, string>();
  for (const s of subs) {
    const l = links.get(s.membershipId);
    if (l && s.status !== 'CANCELLED') usedBy.set(l.orderId, s.membershipId);
  }

  return json(200, {
    subscriptions: sortSubsDesc(subs.map((s) => toRow(s, links.get(s.membershipId), ordersById))),
    payments: orders.map((o) => ({
      orderId: o.orderId, amount: o.amount, createdAt: o.createdAt, status: o.status,
      productId: o.productId ?? null, productName: o.productName, productType: o.productType,
      month: orderMonth(o), linkedMembershipId: usedBy.get(o.orderId) ?? null,
    })),
  });
}

// ── POST /adminSaveMemberSubscription ────────────────────────────────────
// Body: { memberId, membershipId? (edit), targetMonth, productId?, planName,
//         startDate, endDate, totalAmount?, monthlyLimit, weeklyLimit,
//         allowedLegalCancellationsPerMonth?, isAutoRenew?,
//         paymentOrderId? (string to link, null to unlink),
//         currentMonth? (edit: the month it's filed under now),
//         duplicatedFrom?, confirmWarnings? }
// Without confirmWarnings, any warning comes back as
// { needsConfirmation: true, warnings } and nothing is written.
//
// Changing the month on an edit moves the item: the month is part of its key
// (MEMBERSHIP#<month>#<id>), so the old item is deleted and the same
// subscription (same id, usage, history) is written under the new month, in
// one transaction. Nothing else needs rewriting: bookings and cancellations
// store their class's month plus the membership id, and
// findRegistrationMembership falls back to "latest record with this id filed
// at or before the class's month". Booking (membershipForClass) looks for the
// subscription filed under the class's month, then for an earlier one whose
// dates still cover the class — so a subscription for 30/11–31/12 must be
// filed under 2026-11 for November classes to find it. Moving it to a LATER
// month than classes already charged to it would leave those cancellations
// unable to find it, so that's warned about.

export async function adminSaveMemberSubscription(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });

  const memberId = str(body.memberId);
  const editId = str(body.membershipId);
  const planName = str(body.planName);
  const productId = str(body.productId);
  const targetMonth = str(body.targetMonth);
  const monthlyLimit = int(body.monthlyLimit);
  const weeklyLimit = int(body.weeklyLimit);
  const allowedLegal = int(body.allowedLegalCancellationsPerMonth) ?? 2;
  const totalAmount = typeof body.totalAmount === 'number' && Number.isFinite(body.totalAmount) ? Math.round(body.totalAmount * 100) / 100 : null;
  const paymentOrderId = body.paymentOrderId === null ? null : str(body.paymentOrderId) || undefined;
  const duplicatedFrom = str(body.duplicatedFrom);
  const confirmWarnings = body.confirmWarnings === true;

  if (!memberId || !planName || !targetMonth) return json(400, { error: 'missing_fields', required: ['memberId', 'planName', 'targetMonth'] });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) return json(400, { error: 'invalid_month' });
  if (monthlyLimit === null || weeklyLimit === null || monthlyLimit <= 0 || weeklyLimit <= 0 || allowedLegal < 0) {
    return json(400, { error: 'invalid_limits', message: 'Sessions and weekly limit must be more than 0' });
  }
  if (weeklyLimit > monthlyLimit) return json(400, { error: 'invalid_limits', message: 'Weekly limit cannot be more than total sessions' });
  if (totalAmount !== null && totalAmount < 0) return json(400, { error: 'invalid_amount' });

  const startDate = new Date(str(body.startDate));
  const endDate = new Date(str(body.endDate));
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return json(400, { error: 'invalid_dates' });
  if (endDate.getTime() <= startDate.getTime()) return json(400, { error: 'invalid_date_range', message: 'End date must be after start date' });

  const [memberRes, subs, orders] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } })),
    querySubs(memberId),
    queryOrders(memberId),
  ]);
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });

  // A migration bridge can be copied into several months under one id, so
  // the month it's filed under now picks the right one.
  const currentMonth = str(body.currentMonth);
  const existing = editId
    ? (subs.find((s) => s.membershipId === editId && (!currentMonth || s.targetMonth === currentMonth)))
    : undefined;
  if (editId && !existing) return json(404, { error: 'subscription_not_found' });
  if (existing?.status === 'CANCELLED') return json(400, { error: 'subscription_cancelled', message: 'A cancelled subscription can\'t be edited' });
  const monthChanged = !!existing && existing.targetMonth !== targetMonth;
  if (monthChanged && subs.some((s) => s.membershipId === editId && s.targetMonth === targetMonth)) {
    return json(409, { error: 'month_taken', message: 'This subscription already has a copy filed under that month.' });
  }

  const isAutoRenew = typeof body.isAutoRenew === 'boolean' ? body.isAutoRenew : (existing?.isAutoRenew ?? false);
  if (isAutoRenew && !(memberRes.Item as { payment?: { hypToken?: string } }).payment?.hypToken) {
    return json(400, { error: 'auto_renew_requires_saved_card', message: 'Auto-renew needs a saved card' });
  }

  // Effective link after this save.
  const linkOrderId = paymentOrderId === undefined ? existing?.paymentOrderId : (paymentOrderId ?? undefined);
  if (linkOrderId) {
    const order = orders.find((o) => o.orderId === linkOrderId);
    if (!order) return json(400, { error: 'payment_not_found', message: 'That payment isn\'t one of this member\'s payments' });
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const window = { start: startDate.getTime(), end: endDate.getTime() };
  // An edit that leaves the dates alone keeps the status it has, so fixing
  // the amount on an old, replaced subscription can't bring it back to life.
  const prevWindow = existing ? windowOf(existing) : null;
  const datesChanged = !prevWindow || prevWindow.start !== window.start || prevWindow.end !== window.end;
  const status = existing && !datesChanged ? existing.status : statusForWindow(window, nowMs);
  const plan = { productId: productId || existing?.productId, productName: planName };
  const others = subs.filter((s) => s !== existing && s.status !== 'CANCELLED');

  // ── Warnings ──
  const warnings: SubscriptionWarning[] = [];
  for (const s of others) {
    if (samePlan(plan, s) && overlaps(window, windowOf(s))) {
      warnings.push({
        code: 'overlap_same_plan',
        membershipId: s.membershipId,
        message: `Dates overlap "${s.productName || 'subscription'}" for ${s.targetMonth} (${s.status}) on the same plan.`,
      });
    }
  }
  if (linkOrderId && linkOrderId !== existing?.paymentOrderId) {
    const links = resolvePaymentLinks(subs, orders);
    const holder = others.find((s) => links.get(s.membershipId)?.orderId === linkOrderId);
    if (holder) {
      warnings.push({
        code: 'payment_already_linked',
        membershipId: holder.membershipId,
        message: `This payment is already linked to "${holder.productName || 'subscription'}" for ${holder.targetMonth}.`,
      });
    }
  }
  const toSupersede = LIVE.has(status)
    ? others.filter((s) => LIVE.has(s.status) && overlaps(window, windowOf(s)))
    : [];
  for (const s of toSupersede) {
    warnings.push({
      code: 'replaces_live',
      membershipId: s.membershipId,
      message: `"${s.productName || 'subscription'}" for ${s.targetMonth} (${s.status}) will be marked expired and replaced.`,
    });
  }
  if (monthChanged && targetMonth > existing!.targetMonth) {
    const charged = await queryRegsChargedTo(memberId, existing!.membershipId, existing!.targetMonth, targetMonth);
    if (charged > 0) {
      warnings.push({
        code: 'month_later_than_bookings',
        message: `${charged} booking(s) between ${existing!.targetMonth} and ${targetMonth} were charged to this subscription. After moving it to a later month, cancelling those won't return the session to it.`,
      });
    }
  }
  if (toSupersede.length + 2 > MAX_TRANSACT) return json(409, { error: 'too_many_live_memberships' });
  if (warnings.length > 0 && !confirmWarnings) return json(200, { needsConfirmation: true, warnings });

  const by = await adminIdentity(adminUid);
  const membershipId = existing?.membershipId ?? randomUUID();

  const supersedeItems: NonNullable<TransactWriteCommandInput['TransactItems']> = toSupersede.map((old) => ({
    Update: {
      TableName: TABLE_NAME,
      Key: { PK: old.PK, SK: old.SK },
      UpdateExpression: 'SET #status = :expired, supersededBy = :newId, updatedAt = :now, manualLog = list_append(if_not_exists(manualLog, :none), :entry)',
      ConditionExpression: '#status = :prev',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':expired': 'EXPIRED', ':newId': membershipId, ':now': nowIso, ':prev': old.status, ':none': [],
        ':entry': [auditEntry(by, 'edited', 'adminSaveMemberSubscription', old as unknown as Record<string, unknown>,
          { status: 'EXPIRED', supersededBy: membershipId }, { reason: `Replaced by ${planName} (${targetMonth})` }, nowIso)],
      },
    },
  }));

  let write: NonNullable<TransactWriteCommandInput['TransactItems']>[number];
  let migratedRegs: Awaited<ReturnType<typeof queryFutureSubscriptionRegistrations>> = [];

  if (!existing) {
    // Bookings made for this month while no subscription existed are waiting
    // as FUTURE_SUBSCRIPTION — the payment flow moves them onto the new
    // subscription and counts them; a manual fix should do the same.
    if (status !== 'EXPIRED') migratedRegs = await queryFutureSubscriptionRegistrations(memberId, targetMonth);
    const weeklyUsage: Record<string, number> = {};
    for (const r of migratedRegs) if (r.weekKey) weeklyUsage[r.weekKey] = (weeklyUsage[r.weekKey] ?? 0) + 1;
    const created = {
      status, targetMonth, productId: plan.productId, productName: planName,
      startDate: startDate.toISOString(), endDate: endDate.toISOString(), isAutoRenew, monthlyLimit, weeklyLimit,
      allowedLegalCancellationsPerMonth: allowedLegal, totalAmount, paymentOrderId: linkOrderId,
    };
    const entry: ManualLogEntry = duplicatedFrom
      ? auditEntry(by, 'duplicated', 'adminSaveMemberSubscription', null, created, { fromMembershipId: duplicatedFrom }, nowIso)
      : auditEntry(by, 'created', 'adminSaveMemberSubscription', null, created, {}, nowIso);
    write = {
      Put: {
        TableName: TABLE_NAME,
        ConditionExpression: 'attribute_not_exists(PK)',
        Item: {
          PK: `MEMBER#${memberId}`,
          SK: `MEMBERSHIP#${targetMonth}#${membershipId}`,
          membershipId,
          ...(plan.productId ? { productId: plan.productId } : {}),
          productName: planName,
          status,
          targetMonth,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          isAutoRenew,
          monthlyLimit,
          weeklyLimit,
          allowedLegalCancellationsPerMonth: allowedLegal,
          usage: { totalMonthlyUsed: Math.min(migratedRegs.length, monthlyLimit), legalCancellationsUsed: 0, lateCancellationsUsed: 0 },
          weeklyUsage,
          ...(totalAmount !== null ? { totalAmount } : {}),
          ...(linkOrderId ? { paymentOrderId: linkOrderId } : {}),
          isManual: true,
          isManuallyCreated: true,
          createdByAdmin: adminUid,
          manualLog: [entry],
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      },
    };
  } else {
    const next: Record<string, unknown> = {
      productName: planName,
      status,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      isAutoRenew,
      monthlyLimit,
      weeklyLimit,
      allowedLegalCancellationsPerMonth: allowedLegal,
    };
    if (productId) next.productId = productId;
    if (totalAmount !== null) next.totalAmount = totalAmount;
    const changes = Object.keys(next).filter((k) => {
      if (k === 'startDate') return prevWindow!.start !== window.start;
      if (k === 'endDate') return prevWindow!.end !== window.end;
      return (existing as unknown as Record<string, unknown>)[k] !== next[k];
    });
    if (paymentOrderId !== undefined && (paymentOrderId ?? undefined) !== existing.paymentOrderId) changes.push('paymentOrderId');
    if (monthChanged) changes.push('targetMonth');
    if (changes.length === 0) return json(200, { success: true, membershipId, status: existing.status, unchanged: true });

    // before → after for each changed field (dates as stored, ISO).
    const after: Record<string, unknown> = { ...next, startDate: startDate.toISOString(), endDate: endDate.toISOString() };
    if (paymentOrderId !== undefined) after.paymentOrderId = paymentOrderId ?? null;
    if (monthChanged) after.targetMonth = targetMonth;
    const audited = auditEntry(by, 'edited', 'adminSaveMemberSubscription', existing as unknown as Record<string, unknown>, after, {}, nowIso);
    const entry: ManualLogEntry = {
      ...audited,
      changes,
      ...(monthChanged ? { fromMonth: existing.targetMonth, toMonth: targetMonth } : {}),
    };
  if (monthChanged) {
    // Bookings in the new month that were waiting for a subscription.
    if (LIVE.has(status)) migratedRegs = await queryFutureSubscriptionRegistrations(memberId, targetMonth);
    const usage = { ...(existing.usage ?? { totalMonthlyUsed: 0, legalCancellationsUsed: 0, lateCancellationsUsed: 0 }) };
    const weeklyUsage: Record<string, number> = { ...(existing.weeklyUsage ?? {}) };
    usage.totalMonthlyUsed = Math.min((usage.totalMonthlyUsed ?? 0) + migratedRegs.length, monthlyLimit);
    for (const r of migratedRegs) if (r.weekKey) weeklyUsage[r.weekKey] = (weeklyUsage[r.weekKey] ?? 0) + 1;

    const { PK: _pk, SK: _sk, supersededBy, paymentOrderId: prevPay, ...rest } = existing;
    const pay = paymentOrderId === undefined ? prevPay : (paymentOrderId ?? undefined);
    const moved: Record<string, unknown> = {
      ...rest,
      ...next,
      PK: existing.PK,
      SK: `MEMBERSHIP#${targetMonth}#${membershipId}`,
      targetMonth,
      usage,
      weeklyUsage,
      ...(pay ? { paymentOrderId: pay } : {}),
      ...(supersededBy && !LIVE.has(status) ? { supersededBy } : {}),
      isManual: true,
      manualLog: [...(existing.manualLog ?? []), entry],
      updatedAt: nowIso,
    };
    // The old item is only deleted if nothing booked, cancelled or changed it
    // since it was read — otherwise those counts would be lost in the copy.
    const u = existing.usage;
    const guard = u
      ? '#status = :prev AND #usage.totalMonthlyUsed = :u1 AND #usage.legalCancellationsUsed = :u2 AND #usage.lateCancellationsUsed = :u3'
      : '#status = :prev AND attribute_not_exists(#usage)';
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          ...supersedeItems,
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: { PK: existing.PK, SK: existing.SK },
              ConditionExpression: guard,
              ExpressionAttributeNames: { '#status': 'status', '#usage': 'usage' },
              ExpressionAttributeValues: {
                ':prev': existing.status,
                ...(u ? { ':u1': u.totalMonthlyUsed ?? 0, ':u2': u.legalCancellationsUsed ?? 0, ':u3': u.lateCancellationsUsed ?? 0 } : {}),
              },
            },
          },
          { Put: { TableName: TABLE_NAME, Item: moved, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        console.warn('[adminSaveMemberSubscription] move cancelled', err.CancellationReasons);
        return json(409, { error: 'membership_changed', message: 'This subscription changed while saving (a booking or cancellation). Refresh and try again.' });
      }
      throw err;
    }
    await migrateRegs(migratedRegs, membershipId);
    console.log(`[adminSaveMemberSubscription] admin=${adminUid} member=${memberId} move membershipId=${membershipId} ${existing.targetMonth}->${targetMonth} status=${status} superseded=${toSupersede.map((x) => x.membershipId).join(',') || 'none'} migratedRegs=${migratedRegs.length}`);
    return json(200, {
      success: true, membershipId, status, movedFrom: existing.targetMonth, targetMonth,
      supersededMembershipIds: toSupersede.map((x) => x.membershipId), migratedRegistrations: migratedRegs.length,
    });
  }

    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = { ':now': nowIso, ':none': [], ':entry': [entry], ':t': true, ':prev': existing.status };
    const sets: string[] = ['updatedAt = :now', 'isManual = :t', 'manualLog = list_append(if_not_exists(manualLog, :none), :entry)'];
    Object.entries(next).forEach(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
    });
    const removes: string[] = [];
    if (paymentOrderId === null) removes.push('paymentOrderId');
    else if (paymentOrderId) { values[':pay'] = paymentOrderId; sets.push('paymentOrderId = :pay'); }
    // Back to live after being replaced: it no longer points at its replacement.
    if (LIVE.has(status) && existing.supersededBy) removes.push('supersededBy');

    write = {
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: existing.PK, SK: existing.SK },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: 'attribute_exists(PK) AND #status = :prev',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    };
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: [...supersedeItems, write] }));
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      console.warn('[adminSaveMemberSubscription] transaction cancelled', err.CancellationReasons);
      return json(409, { error: 'membership_changed', message: 'This member\'s subscriptions changed while saving. Refresh and try again.' });
    }
    throw err;
  }

  await migrateRegs(migratedRegs, membershipId);

  console.log(`[adminSaveMemberSubscription] admin=${adminUid} member=${memberId} ${existing ? 'edit' : duplicatedFrom ? `duplicate from=${duplicatedFrom}` : 'create'} membershipId=${membershipId} month=${targetMonth} status=${status} payment=${linkOrderId ?? 'none'} superseded=${toSupersede.map((s) => s.membershipId).join(',') || 'none'} migratedRegs=${migratedRegs.length}`);

  return json(existing ? 200 : 201, {
    success: true,
    membershipId,
    status,
    supersededMembershipIds: toSupersede.map((s) => s.membershipId),
    migratedRegistrations: migratedRegs.length,
  });
}

async function migrateRegs(regs: { PK: string; SK: string }[], membershipId: string): Promise<void> {
  await Promise.all(regs.map((reg) => ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: reg.PK, SK: reg.SK },
    UpdateExpression: 'SET consumedFrom = :cf, membershipId = :mid',
    ExpressionAttributeValues: { ':cf': 'MEMBERSHIP', ':mid': membershipId },
  }))));
}

/** Live bookings charged to this subscription for classes in [fromMonth, toMonth). */
async function queryRegsChargedTo(memberId: string, membershipId: string, fromMonth: string, toMonth: string): Promise<number> {
  let count = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to',
      FilterExpression: 'membershipId = :mid AND #status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pk': `MEMBER#${memberId}`, ':from': `REG#${fromMonth}#`, ':to': `REG#${toMonth}#`,
        ':mid': membershipId, ':registered': 'REGISTERED',
      },
      ExclusiveStartKey: lastKey,
    }));
    count += res.Items?.length ?? 0;
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

// ── POST /adminCancelMemberSubscription ──────────────────────────────────
// Body: { memberId, membershipId, currentMonth?, reason? }
// Sets status CANCELLED (no longer usable for booking, never matched to a
// payment). Bookings already made against it stay. It doesn't stop a HYP
// billing agreement — that's paused/cancelled from the billing card.

export async function adminCancelMemberSubscription(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'invalid_json' });
  const memberId = str(body.memberId);
  const membershipId = str(body.membershipId);
  const reason = str(body.reason).slice(0, 300);
  if (!memberId || !membershipId) return json(400, { error: 'missing_fields' });

  const currentMonth = str(body.currentMonth);
  const subs = await querySubs(memberId);
  const sub = subs.find((s) => s.membershipId === membershipId && (!currentMonth || s.targetMonth === currentMonth));
  if (!sub) return json(404, { error: 'subscription_not_found' });
  if (sub.status === 'CANCELLED') return json(200, { success: true, unchanged: true });

  const by = await adminIdentity(adminUid);
  const nowIso = new Date().toISOString();
  const entry: ManualLogEntry = auditEntry(by, 'cancelled', 'adminCancelMemberSubscription', sub as unknown as Record<string, unknown>,
    { status: 'CANCELLED' }, reason ? { reason } : {}, nowIso);

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: sub.PK, SK: sub.SK },
      UpdateExpression: 'SET #status = :cancelled, cancelledAt = :now, cancelledBy = :by, updatedAt = :now, isManual = :t, manualLog = list_append(if_not_exists(manualLog, :none), :entry)'
        + (reason ? ', cancelReason = :reason' : ''),
      ConditionExpression: '#status = :prev',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED', ':now': nowIso, ':by': by, ':t': true, ':none': [], ':entry': [entry], ':prev': sub.status,
        ...(reason ? { ':reason': reason } : {}),
      },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return json(409, { error: 'membership_changed', message: 'This subscription changed while saving. Refresh and try again.' });
    }
    throw err;
  }

  console.log(`[adminCancelMemberSubscription] admin=${adminUid} member=${memberId} membershipId=${membershipId} prevStatus=${sub.status}`);
  return json(200, { success: true });
}
