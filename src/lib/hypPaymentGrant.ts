import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { HypOrderItem, MemberProfileItem, ProductItem } from './entities';
import { monthKey, firstOfNextMonth } from './entities';
import { getHypToken, inquireCardBrand, refundHypTransaction } from './hypClient';
import { getPolicySettings, getMemberFullName } from './hypOrders';
import { queryOpenAgreementsForMember } from './hypAgreementQueries';
import { grantPunchCardSessions, handlePaymentSuccess, type PaymentSuccessPayload } from './paymentGrants';
import { notifyAdminsPaymentFailed, type PaymentFailureTransactionType } from './adminNotify';
import { bridgeTokenToBillingAgreement } from './hypBillingAgreements';

type OrderKey = { PK: string; SK: string };

// Shared by hypPaymentSuccessCallback.ts, hypPaymentFailureCallback.ts, and
// the legacy combined hypPaymentCallback.ts (kept live during the masof
// portal transition) — a single source of truth for what "the transaction
// actually succeeded/failed" means, so a fix only ever needs to happen once
// instead of drifting across near-duplicate handlers.

// ── Success path: grant membership/credits, capture card token, etc. ───────
// Caller is responsible for having already confirmed `ccode === 0` via a
// verified HYP redirect before calling this — it does not re-check.
export async function applyHypPaymentSuccess(
  order: HypOrderItem,
  orderId: string,
  orderKey: OrderKey,
  hypTransactionId: string,
  ccode: number,
): Promise<void> {
  const nowIso = new Date().toISOString();

  // A card-update order is a pure token capture — nothing to grant, and it
  // must never create/touch a membership or billing agreement beyond
  // refreshing the token.
  let punchCardId: string | undefined;
  if (order.isCardUpdateOnly) {
    // no-op
  } else if (order.productType === 'punch_card' || order.productType === 'single_ticket') {
    punchCardId = await grantPunchCardSessions(order.userId, order.productId, order.productName, order.sessions ?? 0);
  } else {
    const payload: PaymentSuccessPayload = {
      event: 'payment_success',
      userId: order.userId,
      targetMonth: order.targetMonth ?? '',
      productId: order.productId,
      productName: order.productName,
      productType: order.productType,
      monthlyLimit: order.monthlyLimit ?? 0,
      weeklyLimit: order.weeklyLimit ?? 0,
      allowedLegalCancellationsPerMonth: order.allowedLegalCancellationsPerMonth ?? 2,
      startDate: order.startDate ?? nowIso,
      endDate: order.endDate ?? nowIso,
      paymentCount: 1,
    };
    await handlePaymentSuccess(order.userId, payload);
  }

  // ── A mid-month purchase bills its assigned plan, not its own price ────
  // Admin assigns a real subscription plan at registration (pending_membership)
  // before the member ever pays anything. Their mid-month product is a
  // one-off bridge; the recurring charge from next month onward must use
  // the ASSIGNED PLAN's price/name/limits, never the mid-month product's own.
  let assignedPlan: { productId: string; productName: string; description?: string; price: number; monthlyLimit: number; weeklyLimit: number; allowedLegalCancellationsPerMonth: number } | undefined;

  if (order.productType === 'mid_month') {
    const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' } }));
    const memberData = memberRes.Item as MemberProfileItem | undefined;
    const assignedPlanId = memberData?.pending_membership?.type ?? '';

    if (assignedPlanId) {
      const planRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${assignedPlanId}`, SK: 'METADATA' } }));
      const plan = planRes.Item as ProductItem | undefined;
      if (plan) {
        assignedPlan = {
          productId: assignedPlanId,
          productName: plan.name ?? order.productName,
          description: plan.description,
          price: plan.price ?? 0,
          monthlyLimit: plan.monthlyLimit && plan.monthlyLimit > 0 ? plan.monthlyLimit : plan.sessions ?? 0,
          weeklyLimit: plan.weeklyLimit && plan.weeklyLimit > 0 ? plan.weeklyLimit : plan.sessions_per_week ?? 0,
          allowedLegalCancellationsPerMonth: plan.allowedLegalCancellationsPerMonth ?? 2,
        };
      } else {
        console.warn(`[hypPaymentGrant] order=${orderId} pending_membership plan ${assignedPlanId} not found — no recurring agreement created`);
      }
    }
  }

  // ── Capture a card token for future use ───────────────────────────────
  let billingAgreementId: string | undefined;
  const needsBillingAgreement = !order.isCardUpdateOnly && ((order.totalPayments > 1 && order.amountPerCharge !== undefined) || !!assignedPlan);
  // A real installment sale (never subscription/assignedPlan, neither of
  // which ever set totalAmount) was already charged in FULL via HYP's own
  // Tash/TashType split on the hosted page — see createHypPaymentPage.ts.
  // There is nothing left for our scheduler to collect later.
  const isInstallmentSale = !assignedPlan && order.totalPayments > 1 && order.totalAmount !== undefined;

  const token = await getHypToken(hypTransactionId);
  if (!token) {
    console.warn(`[hypPaymentGrant] getToken failed for order ${orderId}, transId=${hypTransactionId} — no token saved`);
  } else {
    // Cosmetic only (which brand icon to show) — swallows its own errors,
    // never blocks or fails this callback.
    const cardBrand = await inquireCardBrand(hypTransactionId);

    if (needsBillingAgreement) {
      const kind = order.productType === 'subscription' || assignedPlan ? 'subscription' : 'store_installment';

      // A member re-purchasing must not end up with two open agreements of
      // the same kind — cancel whatever old one is still active/paused first.
      const staleAgreements = await queryOpenAgreementsForMember(order.userId, kind);
      await Promise.all(staleAgreements.map((stale) =>
        ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: stale.PK, SK: stale.SK },
          UpdateExpression: 'SET #status = :cancelled, updatedAt = :now REMOVE GSI3PK, GSI3SK',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':cancelled': 'cancelled', ':now': nowIso },
        })),
      ));

      const agreementId = randomUUID();
      billingAgreementId = agreementId;

      if (isInstallmentSale) {
        // HYP already collected the FULL amount on the hosted page via its
        // own Tash/TashType installment split with the card issuer — there
        // is nothing left for us to charge later. This record is
        // paid-in-full bookkeeping only; it must never carry
        // GSI3PK/GSI3SK/nextChargeDate, or the nightly cron would charge
        // the member again on top of what HYP/the issuer already split.
        await ddb.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `AGREEMENT#${agreementId}`,
            SK: 'METADATA',
            GSI1PK: `MEMBER#${order.userId}`,
            GSI1SK: `AGREEMENT#${kind}#${agreementId}`,
            GSI2PK: 'AGREEMENT',
            GSI2SK: `${nowIso}#${agreementId}`,
            agreementId,
            userId: order.userId,
            status: 'completed',
            kind,
            productId: order.productId,
            productName: order.productName,
            ...(order.description ? { description: order.description } : {}),
            token: token.token,
            tokenExpiryMonth: token.expiryMonth,
            tokenExpiryYear: token.expiryYear,
            amountPerCharge: order.amountPerCharge,
            totalAmount: order.totalAmount,
            installmentsCount: order.totalPayments,
            installmentAmount: order.amountPerCharge,
            totalPayments: order.totalPayments,
            paymentsCompleted: order.totalPayments,
            consecutiveFailures: 0,
            sourceOrderId: orderId,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        }));
      } else {
        // Every recurring charge lands on the 1st of the month, regardless
        // of which day the first payment happened on.
        const nextChargeDate = firstOfNextMonth(new Date());
        const assignedPlanTotalPayments = assignedPlan ? (await getPolicySettings()).standingOrderMonths : undefined;

        await ddb.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `AGREEMENT#${agreementId}`,
            SK: 'METADATA',
            GSI1PK: `MEMBER#${order.userId}`,
            GSI1SK: `AGREEMENT#${kind}#${agreementId}`,
            GSI2PK: 'AGREEMENT',
            GSI2SK: `${nowIso}#${agreementId}`,
            GSI3PK: 'AGREEMENT_STATUS#active',
            GSI3SK: nextChargeDate.toISOString(),
            agreementId,
            userId: order.userId,
            status: 'active',
            kind,
            productId: assignedPlan?.productId ?? order.productId,
            productName: assignedPlan?.productName ?? order.productName,
            ...((assignedPlan?.description ?? order.description) ? { description: assignedPlan?.description ?? order.description } : {}),
            token: token.token,
            tokenExpiryMonth: token.expiryMonth,
            tokenExpiryYear: token.expiryYear,
            amountPerCharge: assignedPlan?.price ?? order.amountPerCharge,
            totalPayments: assignedPlanTotalPayments ?? order.totalPayments,
            paymentsCompleted: 1,
            nextChargeDate: nextChargeDate.toISOString(),
            ...(kind === 'subscription' ? { targetMonth: monthKey(nextChargeDate) } : {}),
            consecutiveFailures: 0,
            sourceOrderId: orderId,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        }));
      }

      // The assigned plan is now active via this agreement — clear the
      // pending marker so a second mid-month purchase can't duplicate it.
      if (assignedPlan) {
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' },
          UpdateExpression: 'REMOVE pending_membership',
        }));
      }
    }

    // Refresh the token on this member's OTHER open billing agreements too
    // — paying with a new card anywhere means that's their real card now.
    const otherAgreements = (await queryOpenAgreementsForMember(order.userId)).filter((a) => a.agreementId !== billingAgreementId);
    await Promise.all(otherAgreements.map((a) =>
      ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: a.PK, SK: a.SK },
        UpdateExpression: 'SET token = :t, tokenExpiryMonth = :em, tokenExpiryYear = :ey, updatedAt = :now',
        ExpressionAttributeValues: { ':t': token.token, ':em': token.expiryMonth, ':ey': token.expiryYear, ':now': nowIso },
      })),
    ));

    const memberRes2 = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' } }));
    const currentPayment = (memberRes2.Item as MemberProfileItem | undefined)?.payment;
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' },
      UpdateExpression: 'SET payment = :p REMOVE admin.forceShowPaymentButton',
      ExpressionAttributeValues: {
        ':p': {
          ...currentPayment,
          hypToken: token.token,
          hypTokenExpiryMonth: token.expiryMonth,
          hypTokenExpiryYear: token.expiryYear,
          hypTokenProductId: order.productId,
          hypTokenUpdatedAt: nowIso,
          hasSavedCard: true,
          ...(cardBrand ? { cardBrand } : {}),
        },
      },
    }));
    if (!cardBrand) {
      // Explicit removal, mirroring the original's FieldValue.delete() when
      // no brand could be resolved.
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' },
        UpdateExpression: 'REMOVE payment.cardBrand',
      })).catch(() => {});
    }

    // This order's own needsBillingAgreement branch above already covers
    // itself — this call is for any OTHER plan (a pending_membership, or an
    // active membership admin-granted without a checkout) that had no
    // agreement yet and can now use the token this order just (re)saved.
    // bridgeTokenToBillingAgreement no-ops instantly if one already exists.
    await bridgeTokenToBillingAgreement(order.userId);
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: orderKey,
    UpdateExpression: 'SET #status = :completed, hypTransactionId = :tid, hypCCode = :ccode, verifiedAt = :now, updatedAt = :now'
      + (billingAgreementId ? ', billingAgreementId = :bid' : '')
      + (punchCardId ? ', punchCardId = :pcid' : ''),
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':completed': 'completed', ':tid': hypTransactionId, ':ccode': ccode, ':now': nowIso,
      ...(billingAgreementId ? { ':bid': billingAgreementId } : {}),
      ...(punchCardId ? { ':pcid': punchCardId } : {}),
    },
  }));

  // The ₪1 verification charge on a card-update order was only ever a
  // means to get a token — refund it immediately now that the token has
  // been captured and pushed onto the member's billing agreement(s).
  if (order.isCardUpdateOnly && hypTransactionId) {
    try {
      const refund = await refundHypTransaction(hypTransactionId, order.amount);
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: orderKey,
        UpdateExpression: refund.success
          ? 'SET #status = :refunded, refundedAmount = :amt, refundedAt = :now, refundedBy = :sys'
          : 'SET #status = :completed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: refund.success
          ? { ':refunded': 'refunded', ':amt': order.amount, ':now': new Date().toISOString(), ':sys': 'system' }
          : { ':completed': 'completed' },
      }));
      if (!refund.success) {
        console.error(`[hypPaymentGrant] card-update order=${orderId} auto-refund failed ccode=${refund.ccode}`);
      }
    } catch (err: any) {
      console.error(`[hypPaymentGrant] card-update order=${orderId} auto-refund threw:`, err);
    }
  }

  console.log(`[hypPaymentGrant] order=${orderId} user=${order.userId} completed transId=${hypTransactionId}`);
}

// ── Failure path: mark the order failed and alert admins ───────────────────
export async function markOrderFailedAndNotifyAdmins(
  order: HypOrderItem,
  orderId: string,
  orderKey: OrderKey,
  ccode: number,
): Promise<void> {
  const nowIso = new Date().toISOString();

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: orderKey,
    UpdateExpression: 'SET #status = :failed, hypCCode = :ccode, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':failed': 'failed', ':ccode': Number.isFinite(ccode) ? ccode : -1, ':now': nowIso },
  }));

  // A card-update-only order is just a token capture, not a real
  // purchase — nothing an admin needs to act on if it fails.
  if (order.isCardUpdateOnly) return;

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' } }));
  const member = memberRes.Item as MemberProfileItem | undefined;
  const transactionType: PaymentFailureTransactionType =
    order.productType === 'subscription' || order.productType === 'mid_month' ? 'subscription_signup' : 'store_purchase';

  await notifyAdminsPaymentFailed({
    userId: order.userId,
    userName: member ? getMemberFullName(member) : 'Unknown Member',
    transactionType,
    itemName: order.productName,
    amount: order.amount,
    ccode: Number.isFinite(ccode) ? ccode : -1,
    hadCardOnFile: true,
    sourceId: orderId,
  });
}
