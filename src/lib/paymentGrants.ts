import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ProductItem, RegistrationItem } from './entities';
import { putPunchCardItem } from './punchCards';
import { queryFutureSubscriptionRegistrations, queryAllActiveMemberships, queryMembershipForMonth } from './membershipQueries';

// Shared payment-success/payment-failure business logic, called by the
// HYP-driven flow (hypPayments.ts) and adminEvictFutureRegistrations.ts.
// Ported from functions/src/paymentGrants.ts. The Make.com webhook that
// originally shared this logic (makePaymentWebhook.ts) has been retired now
// that HYP is the only payment path — see functions/src/paymentWebhook.ts
// for the still-live legacy Firebase source, untouched by this migration.

export interface PaymentSuccessPayload {
  event: 'payment_success';
  userId: string;
  targetMonth: string;
  productId: string;
  productName: string;
  productType: 'subscription' | 'mid_month' | 'punch_card' | 'single_ticket';
  monthlyLimit: number;
  weeklyLimit: number;
  allowedLegalCancellationsPerMonth: number;
  startDate: string;
  endDate: string;
  paymentCount: number;
}

export async function handlePaymentSuccess(userId: string, payload: PaymentSuccessPayload): Promise<void> {
  // Accept both camelCase (new scenarios) and snake_case (legacy) field names.
  const raw = payload as unknown as Record<string, unknown>;

  const targetMonth = (typeof raw.targetMonth === 'string' ? raw.targetMonth : '') || (typeof raw.target_month === 'string' ? raw.target_month : '');
  const startDate = (typeof raw.startDate === 'string' ? raw.startDate : '') || (typeof raw.start_date === 'string' ? raw.start_date : '');
  const endDate = (typeof raw.endDate === 'string' ? raw.endDate : '') || (typeof raw.end_date === 'string' ? raw.end_date : '');

  let productId = (typeof raw.productId === 'string' ? raw.productId : '') || (typeof raw.product_id === 'string' ? raw.product_id : '');
  let productName = (typeof raw.productName === 'string' ? raw.productName : '') || (typeof raw.product_name === 'string' ? raw.product_name : '');
  let productType = ((typeof raw.productType === 'string' ? raw.productType : '') || (typeof raw.product_type === 'string' ? raw.product_type : '')) as PaymentSuccessPayload['productType'];
  let monthlyLimit = typeof raw.monthlyLimit === 'number' ? raw.monthlyLimit : typeof raw.sessions === 'number' ? (raw.sessions as number) : 0;
  let weeklyLimit = typeof raw.weeklyLimit === 'number' ? raw.weeklyLimit : typeof raw.sessions_per_week === 'number' ? (raw.sessions_per_week as number) : 0;
  let allowedLegalCancellationsPerMonth = typeof raw.allowedLegalCancellationsPerMonth === 'number' ? raw.allowedLegalCancellationsPerMonth : 2;

  if (productId && (monthlyLimit === 0 || weeklyLimit === 0 || !productName)) {
    try {
      const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } }));
      const p = productRes.Item as ProductItem | undefined;
      if (p) {
        if (!productName && p.name) productName = p.name;
        if (monthlyLimit === 0) monthlyLimit = p.monthlyLimit && p.monthlyLimit > 0 ? p.monthlyLimit : p.sessions ?? 0;
        if (weeklyLimit === 0) weeklyLimit = p.weeklyLimit && p.weeklyLimit > 0 ? p.weeklyLimit : p.sessions_per_week ?? 0;
        if (!allowedLegalCancellationsPerMonth && p.allowedLegalCancellationsPerMonth) allowedLegalCancellationsPerMonth = p.allowedLegalCancellationsPerMonth;
        if (!productType && p.type) productType = p.type as PaymentSuccessPayload['productType'];
      }
    } catch (err: any) {
      console.warn('[paymentGrants] product fallback fetch failed:', err);
    }
  }

  // ── Punch card / single ticket purchases go to the wallet, not memberships ──
  if (productType === 'punch_card' || productType === 'single_ticket') {
    await grantPunchCardSessions(userId, productId, productName, monthlyLimit);
    return;
  }

  const isAutoRenew = productType === 'subscription';

  // ── Idempotency: skip if membership already active for this month ─────────
  const existing = await queryMembershipForMonth(userId, targetMonth);
  if (existing?.status === 'ACTIVE') {
    console.log(`[paymentGrants] Membership for ${userId} in ${targetMonth} already active — skipping create.`);
    return;
  }

  // ── Supersede any other ACTIVE membership before creating the new one ─────
  const priorActive = await queryAllActiveMemberships(userId);

  // ── Collect all FUTURE_SUBSCRIPTION registrations for this month ──────────
  const futureRegs = await queryFutureSubscriptionRegistrations(userId, targetMonth);

  let totalMonthlyUsed = futureRegs.length;
  const weeklyUsage: Record<string, number> = {};
  for (const reg of futureRegs) {
    const wKey = reg.weekKey ?? '';
    if (wKey) weeklyUsage[wKey] = (weeklyUsage[wKey] ?? 0) + 1;
  }
  totalMonthlyUsed = Math.min(totalMonthlyUsed, monthlyLimit);

  const membershipId = randomUUID();
  const nowIso = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `MEMBER#${userId}`,
      SK: `MEMBERSHIP#${targetMonth}#${membershipId}`,
      membershipId,
      productId,
      productName,
      status: 'ACTIVE',
      targetMonth,
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      isAutoRenew,
      monthlyLimit,
      weeklyLimit,
      allowedLegalCancellationsPerMonth,
      usage: { totalMonthlyUsed, legalCancellationsUsed: 0, lateCancellationsUsed: 0 },
      weeklyUsage,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  }));

  await Promise.all(priorActive.map((old) =>
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: old.PK, SK: old.SK },
      UpdateExpression: 'SET #status = :expired, supersededBy = :newId, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':expired': 'EXPIRED', ':newId': membershipId, ':now': nowIso },
    })),
  ));

  await Promise.all(futureRegs.map((reg) =>
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: reg.PK, SK: reg.SK },
      UpdateExpression: 'SET consumedFrom = :cf, membershipId = :mid',
      ExpressionAttributeValues: { ':cf': 'MEMBERSHIP', ':mid': membershipId },
    })),
  ));

  // ── For mid_month products: remove user from assigned_to after purchase ───
  if (productType === 'mid_month' && productId) {
    const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } }));
    const product = productRes.Item as ProductItem | undefined;
    if (product) {
      const assignedTo = (product.assigned_to ?? []).filter((id) => id !== userId);
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' },
        UpdateExpression: 'SET assigned_to = :a',
        ExpressionAttributeValues: { ':a': assignedTo },
      }));
    }
  }

  console.log(`[paymentGrants] payment_success userId=${userId} month=${targetMonth} membershipId=${membershipId} migratedRegistrations=${futureRegs.length}`);
}

// ─── Punch card grant ──────────────────────────────────────────────────────
// Punch card purchases are stored in the wallet, not as membership items.
// NOTE: unlike products.ts's grantPunchCard/autoGrantProduct, this
// deliberately does NOT mirror into the legacy extra.punch_cards array —
// same as the original functions/src/paymentGrants.ts.
export async function grantPunchCardSessions(userId: string, productId: string, productName: string, sessions: number): Promise<string> {
  const cardId = randomUUID();
  await putPunchCardItem({ memberId: userId, cardId, remainingPunches: sessions, expiryDate: null, notes: productName, source: 'store_purchase' });

  // Hide the product from the store once purchased (non-public products only).
  const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } }));
  const product = productRes.Item as ProductItem | undefined;
  if (product && !product.is_public) {
    const assignedTo = (product.assigned_to ?? []).filter((id) => id !== userId);
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' },
      UpdateExpression: 'SET assigned_to = :a',
      ExpressionAttributeValues: { ':a': assignedTo },
    }));
  }

  console.log(`[paymentGrants] punch_card payment userId=${userId} product=${productId} sessions=${sessions} cardId=${cardId}`);
  return cardId;
}

// ─── payment_failed / subscription_cancelled handler ─────────────────────────

export async function handlePaymentFailure(userId: string, targetMonth: string): Promise<void> {
  const nowIso = new Date().toISOString();

  const monthMembership = await queryMembershipForMonth(userId, targetMonth);
  if (monthMembership) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: monthMembership.PK, SK: monthMembership.SK },
      UpdateExpression: 'SET #status = :pastDue, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pastDue': 'past_due', ':now': nowIso },
    }));
    console.log(`[paymentGrants] Marked membership past_due for ${userId} in ${targetMonth}`);
  }

  const priorActive = await queryAllActiveMemberships(userId);
  await Promise.all(priorActive.map((old) =>
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: old.PK, SK: old.SK },
      UpdateExpression: 'SET #status = :expired, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': nowIso },
    })),
  ));
  if (priorActive.length > 0) {
    console.log(`[paymentGrants] Expired ${priorActive.length} membership(s) for ${userId} after failed renewal (${targetMonth})`);
  }

  await evictFutureRegistrations(userId, targetMonth);
}

// ─── Eviction routine ─────────────────────────────────────────────────────
// Finds every REGISTERED/FUTURE_SUBSCRIPTION registration the user has in
// `targetMonth` and marks them LATE_CANCELLED, then decrements the class
// attendee counter. Called on payment failure; also exposed standalone as
// adminEvictFutureRegistrations (paymentWebhook.ts).
export async function evictFutureRegistrations(userId: string, targetMonth: string): Promise<void> {
  const futureRegs = await queryFutureSubscriptionRegistrations(userId, targetMonth);
  if (futureRegs.length === 0) {
    console.log(`[eviction] No future registrations to evict for ${userId} in ${targetMonth}`);
    return;
  }

  const nowIso = new Date().toISOString();

  await Promise.all(futureRegs.map(async (reg: RegistrationItem) => {
    const classId = reg.classId;
    await Promise.all([
      ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: reg.PK, SK: reg.SK },
        UpdateExpression: 'SET #status = :lateCancelled, cancelledAt = :now, cancellationReason = :reason',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':lateCancelled': 'LATE_CANCELLED', ':now': nowIso, ':reason': 'payment_failure_eviction' },
      })),
      ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
        UpdateExpression: 'ADD currentAttendeesCount :negOne',
        ExpressionAttributeValues: { ':negOne': -1 },
      })),
    ]);
  }));

  console.log(`[eviction] Evicted ${futureRegs.length} future registrations for userId=${userId} month=${targetMonth}`);
}
