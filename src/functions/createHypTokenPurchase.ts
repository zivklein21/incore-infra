import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem, ProductItem } from '../lib/entities';
import { firstOfNextMonth, monthKey } from '../lib/entities';
import { buildOrderFromProduct, orderBuildErrorStatus, orderFromBuild, newOrderKey, getMemberIdNumber, getPolicySettings, HYP_NO_ID_PLACEHOLDER } from '../lib/hypOrders';
import { queryOpenAgreementsForMember } from '../lib/hypAgreementQueries';
import { chargeHypToken } from '../lib/hypClient';
import { grantPunchCardSessions, handlePaymentSuccess, type PaymentSuccessPayload } from '../lib/paymentGrants';

// POST /createHypTokenPurchase
// Auth: Cognito JWT
// Charges the member's saved card token directly, no hosted page/redirect.
// Body: { productId: string, installments?: number }
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { productId?: unknown; installments?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
  const requestedInstallments = typeof body.installments === 'number' ? body.installments : undefined;
  if (!productId) return json(400, { error: 'missing_fields', required: ['productId'] });

  const result = await buildOrderFromProduct(uid, productId, requestedInstallments);
  if (!result.ok) return json(orderBuildErrorStatus(result.error), { error: result.error });
  const { member, build } = result;

  const payment = member.payment;
  const token = payment?.hypToken ?? '';
  const expiryMonth = payment?.hypTokenExpiryMonth ?? 0;
  const expiryYear = payment?.hypTokenExpiryYear ?? 0;
  if (!token || !expiryMonth || !expiryYear) return json(400, { error: 'no_saved_token' });

  // A real multi-installment sale (not a subscription, which recurs
  // indefinitely and has no totalAmount) is charged as ONE HYP transaction
  // for the FULL amount, tagged with Tash/TashType — HYP splits the payment
  // with the card issuer itself. We must never pre-split this ourselves nor
  // charge again later for the remaining installments.
  const isInstallmentSale = build.totalPayments > 1 && build.totalAmount !== undefined;
  const chargeAmount = isInstallmentSale ? build.totalAmount! : build.firstChargeAmount;

  const { PK, SK, orderId } = newOrderKey();
  const order = orderFromBuild(orderId, uid, productId, build);
  order.amount = chargeAmount;
  if (isInstallmentSale) {
    order.installmentsCount = build.totalPayments;
    order.installmentAmount = build.amountPerCharge;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: order }));

  let chargeResult;
  try {
    chargeResult = await chargeHypToken({
      token, expiryMonth, expiryYear,
      amount: chargeAmount,
      userId: getMemberIdNumber(member) || HYP_NO_ID_PLACEHOLDER,
      clientName: [build.clientFirstName, build.clientLastName].filter(Boolean).join(' '),
      info: build.productName,
      email: build.email || undefined,
      ...(isInstallmentSale ? { tash: build.totalPayments, tashType: 1 } : {}),
    });
  } catch (err: any) {
    console.error(`[createHypTokenPurchase] user=${uid} charge threw:`, err);
    chargeResult = { success: false, ccode: -1 };
  }

  if (!chargeResult.success) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK, SK },
      UpdateExpression: 'SET #status = :failed, hypCCode = :ccode, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed', ':ccode': chargeResult.ccode, ':now': new Date().toISOString() },
    }));
    return json(402, { success: false, error: 'charge_failed', ccode: chargeResult.ccode });
  }

  // ── Apply the grant, same as hypPaymentCallback ──────────────────────────
  if (build.productType === 'punch_card' || build.productType === 'single_ticket') {
    await grantPunchCardSessions(uid, productId, build.productName, build.sessions);
  } else {
    const payload: PaymentSuccessPayload = {
      event: 'payment_success',
      userId: uid,
      targetMonth: build.targetMonth ?? '',
      productId,
      productName: build.productName,
      productType: build.productType,
      monthlyLimit: build.monthlyLimit,
      weeklyLimit: build.weeklyLimit,
      allowedLegalCancellationsPerMonth: build.allowedLegalCancellationsPerMonth,
      startDate: build.startDate ?? new Date().toISOString(),
      endDate: build.endDate ?? new Date().toISOString(),
      paymentCount: 1,
    };
    await handlePaymentSuccess(uid, payload);
  }

  // ── A mid-month purchase bills its assigned plan, not its own price ──────
  // Same logic as hypPaymentCallback.ts — admin assigns a real subscription
  // plan at registration (pending_membership) before the member ever pays
  // anything. Their mid-month product is a one-off bridge; the recurring
  // charge from next month onward must use the ASSIGNED PLAN's
  // price/name/limits, never the mid-month product's own. Without this, a
  // member who pays for their bridge product with an already-saved token
  // (this endpoint) instead of a fresh hosted checkout (hypPaymentCallback)
  // ended up with a mis-tagged 'store_installment' agreement charging the
  // bridge product's own price forever, instead of becoming a real
  // 'subscription' agreement at their assigned plan's price.
  let assignedPlan: { productId: string; productName: string; price: number; monthlyLimit: number; weeklyLimit: number; allowedLegalCancellationsPerMonth: number } | undefined;

  if (build.productType === 'mid_month') {
    const assignedPlanId = member.pending_membership?.type ?? '';
    if (assignedPlanId) {
      const planRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${assignedPlanId}`, SK: 'METADATA' } }));
      const plan = planRes.Item as ProductItem | undefined;
      if (plan) {
        assignedPlan = {
          productId: assignedPlanId,
          productName: plan.name ?? build.productName,
          price: plan.price ?? 0,
          monthlyLimit: plan.monthlyLimit && plan.monthlyLimit > 0 ? plan.monthlyLimit : plan.sessions ?? 0,
          weeklyLimit: plan.weeklyLimit && plan.weeklyLimit > 0 ? plan.weeklyLimit : plan.sessions_per_week ?? 0,
          allowedLegalCancellationsPerMonth: plan.allowedLegalCancellationsPerMonth ?? 2,
        };
      } else {
        console.warn(`[createHypTokenPurchase] user=${uid} pending_membership plan ${assignedPlanId} not found — no recurring agreement created`);
      }
    }
  }

  // ── Same token drives future installments too, if this is a plan ─────────
  let billingAgreementId: string | undefined;
  const needsBillingAgreement = (build.totalPayments > 1 && build.amountPerCharge !== undefined) || !!assignedPlan;
  if (needsBillingAgreement) {
    const kind = build.productType === 'subscription' || assignedPlan ? 'subscription' : 'store_installment';

    // A member re-purchasing must not end up with two open agreements of
    // the same kind — cancel whatever old one is still active/paused first.
    const nowIso = new Date().toISOString();
    const staleAgreements = await queryOpenAgreementsForMember(uid, kind);
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

    if (isInstallmentSale) {
      // HYP already collected the FULL amount in this one charge via its own
      // Tash/TashType installment split with the card issuer — there is
      // nothing left for us to charge later. This record is paid-in-full
      // bookkeeping for the admin Billing Agreements screen only; it must
      // never carry GSI3PK/GSI3SK/nextChargeDate, or the nightly cron would
      // charge the member again on top of what HYP/the issuer already split.
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `AGREEMENT#${agreementId}`,
          SK: 'METADATA',
          GSI1PK: `MEMBER#${uid}`,
          GSI1SK: `AGREEMENT#${kind}#${agreementId}`,
          GSI2PK: 'AGREEMENT',
          GSI2SK: `${nowIso}#${agreementId}`,
          agreementId,
          userId: uid,
          status: 'completed',
          kind,
          productId,
          productName: build.productName,
          token, tokenExpiryMonth: expiryMonth, tokenExpiryYear: expiryYear,
          amountPerCharge: build.amountPerCharge,
          totalAmount: build.totalAmount,
          installmentsCount: build.totalPayments,
          installmentAmount: build.amountPerCharge,
          totalPayments: build.totalPayments,
          paymentsCompleted: build.totalPayments,
          consecutiveFailures: 0,
          sourceOrderId: orderId,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      }));
    } else {
      const nextChargeDate = firstOfNextMonth(new Date());
      const assignedPlanTotalPayments = assignedPlan ? (await getPolicySettings()).standingOrderMonths : undefined;
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `AGREEMENT#${agreementId}`,
          SK: 'METADATA',
          GSI1PK: `MEMBER#${uid}`,
          GSI1SK: `AGREEMENT#${kind}#${agreementId}`,
          GSI2PK: 'AGREEMENT',
          GSI2SK: `${nowIso}#${agreementId}`,
          GSI3PK: 'AGREEMENT_STATUS#active',
          GSI3SK: nextChargeDate.toISOString(),
          agreementId,
          userId: uid,
          status: 'active',
          kind,
          productId: assignedPlan?.productId ?? productId,
          productName: assignedPlan?.productName ?? build.productName,
          token, tokenExpiryMonth: expiryMonth, tokenExpiryYear: expiryYear,
          amountPerCharge: assignedPlan?.price ?? build.amountPerCharge,
          totalPayments: assignedPlanTotalPayments ?? build.totalPayments,
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
    billingAgreementId = agreementId;
  }

  const memberPaymentUpdate: MemberProfileItem['payment'] = {
    ...member.payment,
    hypToken: token,
    hypTokenExpiryMonth: expiryMonth,
    hypTokenExpiryYear: expiryYear,
    hypTokenProductId: productId,
    hypTokenUpdatedAt: new Date().toISOString(),
    hasSavedCard: true,
  };
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET payment = :p',
    ExpressionAttributeValues: { ':p': memberPaymentUpdate },
  }));

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK, SK },
    // hypTransactionId is what adminRefundOrder.ts/adminRefundMemberLastPayment.ts
    // key a refund off of — omitting it (as this handler used to) left every
    // saved-card purchase permanently unrefundable ("missing_transaction_id").
    UpdateExpression: 'SET #status = :completed, hypCCode = :zero, verifiedAt = :now, updatedAt = :now'
      + (billingAgreementId ? ', billingAgreementId = :bid' : '')
      + (chargeResult.transactionId ? ', hypTransactionId = :tid' : ''),
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':completed': 'completed', ':zero': 0, ':now': new Date().toISOString(),
      ...(billingAgreementId ? { ':bid': billingAgreementId } : {}),
      ...(chargeResult.transactionId ? { ':tid': chargeResult.transactionId } : {}),
    },
  }));

  console.log(`[createHypTokenPurchase] user=${uid} product=${productId} order=${orderId} completed`);
  return json(200, {
    success: true,
    orderId,
    amountCharged: chargeAmount,
    ...(isInstallmentSale ? {
      totalAmount: build.totalAmount,
      installmentsCount: build.totalPayments,
      installmentAmount: build.amountPerCharge,
    } : {}),
  });
}
