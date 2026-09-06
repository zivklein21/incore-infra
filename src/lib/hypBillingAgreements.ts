import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { HypBillingAgreementItem, MemberProfileItem, ProductItem, MembershipItem } from './entities';
import { monthKey, endOfMonth, addMonths, firstOfNextMonth } from './entities';
import { chargeHypToken } from './hypClient';
import { getMemberIdNumber, getMemberFullName, buildHypInfo, getPolicySettings, HYP_NO_ID_PLACEHOLDER } from './hypOrders';
import { queryOpenAgreementsForMember } from './hypAgreementQueries';
import { handlePaymentSuccess, handlePaymentFailure, type PaymentSuccessPayload } from './paymentGrants';
import { notifyAdminsPaymentFailed, type PaymentFailureTransactionType } from './adminNotify';

// Charges a single billing agreement and applies its grant/failure handling.
// Used by both the nightly cron (chargeHypBillingAgreements) and the admin
// "charge now" override (adminChargeHypAgreementNow) — same logic either way.
export async function chargeOneAgreement(agreement: HypBillingAgreementItem): Promise<{ success: boolean; ccode: number }> {
  const isFinalCharge = agreement.paymentsCompleted + 1 >= agreement.totalPayments;
  const chargeAmount = isFinalCharge && agreement.totalAmount !== undefined
    ? Math.round((agreement.totalAmount - agreement.amountPerCharge * (agreement.totalPayments - 1)) * 100) / 100
    : agreement.amountPerCharge;

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${agreement.userId}`, SK: 'PROFILE' } }));
  const member = memberRes.Item as MemberProfileItem | undefined;
  const chargeUserId = (member && getMemberIdNumber(member)) || HYP_NO_ID_PLACEHOLDER;
  const chargeClientName = member ? getMemberFullName(member) : 'Member';
  const chargeEmail = member?.identity?.email || member?.email || '';

  let result: { success: boolean; ccode: number; transactionId?: string; authCode?: string };
  if (!agreement.token) {
    // No card on file (e.g. admin cleared it) — nothing to charge, don't
    // waste a HYP call on empty credentials. Same failure path as a real
    // decline: retries once, then gives up and flags the admin.
    result = { success: false, ccode: -1 };
  } else {
    try {
      result = await chargeHypToken({
        token: agreement.token,
        expiryMonth: agreement.tokenExpiryMonth,
        expiryYear: agreement.tokenExpiryYear,
        amount: chargeAmount,
        userId: chargeUserId,
        clientName: chargeClientName,
        info: buildHypInfo(agreement.productName, agreement.description),
        email: chargeEmail || undefined,
        sendReceipt: true,
      });
    } catch (err: any) {
      console.error(`[chargeOneAgreement] agreement=${agreement.agreementId} charge threw:`, err);
      result = { success: false, ccode: -1 };
    }
  }

  const nowIso = new Date().toISOString();

  if (result.success) {
    const paymentsCompleted = agreement.paymentsCompleted + 1;
    const completed = paymentsCompleted >= agreement.totalPayments;

    // Record this charge as its own order — the initial purchase already has
    // one, but recurring cron/admin charges didn't, which left
    // adminRefundMemberLastPayment unable to find anything but the member's
    // very first-ever payment. Every completed charge now gets one.
    const chargeOrderId = randomUUID();
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORDER#${chargeOrderId}`,
        SK: 'METADATA',
        GSI1PK: `MEMBER#${agreement.userId}`,
        GSI1SK: `ORDER#${nowIso}#${chargeOrderId}`,
        GSI2PK: 'ORDER',
        GSI2SK: `${nowIso}#${chargeOrderId}`,
        orderId: chargeOrderId,
        userId: agreement.userId,
        status: 'completed',
        createdAt: nowIso,
        updatedAt: nowIso,
        amount: chargeAmount,
        productId: agreement.productId,
        productName: agreement.productName,
        productType: agreement.kind === 'subscription' ? 'subscription' : 'punch_card',
        paymentMethod: 'direct_debit',
        totalPayments: agreement.totalPayments,
        amountPerCharge: agreement.amountPerCharge,
        ...(agreement.totalAmount !== undefined ? { totalAmount: agreement.totalAmount } : {}),
        ...(result.transactionId ? { hypTransactionId: result.transactionId } : {}),
        hypCCode: result.ccode,
        verifiedAt: nowIso,
        billingAgreementId: agreement.agreementId,
      },
    }));

    if (agreement.kind === 'subscription') {
      const nextMonth = agreement.targetMonth ?? monthKey(new Date());
      const payload: PaymentSuccessPayload = {
        event: 'payment_success',
        userId: agreement.userId,
        targetMonth: nextMonth,
        productId: agreement.productId,
        productName: agreement.productName,
        productType: 'subscription',
        monthlyLimit: 0, // resolved from the product item inside handlePaymentSuccess
        weeklyLimit: 0,
        allowedLegalCancellationsPerMonth: 2,
        startDate: new Date().toISOString(),
        endDate: endOfMonth(new Date()).toISOString(),
        paymentCount: paymentsCompleted,
      };
      await handlePaymentSuccess(agreement.userId, payload);
    }
    // store_installment: sessions were already granted up front — nothing further to do.

    const currentTargetMonthDate = agreement.targetMonth ? new Date(`${agreement.targetMonth}-01`) : new Date();
    const newNextChargeDate = firstOfNextMonth(new Date());

    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: agreement.PK, SK: agreement.SK },
      UpdateExpression: completed
        ? 'SET paymentsCompleted = :pc, #status = :completed, consecutiveFailures = :zero, lastChargeResult = :lcr, updatedAt = :now REMOVE nextChargeDate, GSI3PK, GSI3SK'
        : (agreement.kind === 'subscription'
          ? 'SET paymentsCompleted = :pc, #status = :active, consecutiveFailures = :zero, nextChargeDate = :ncd, targetMonth = :tm, lastChargeResult = :lcr, updatedAt = :now, GSI3PK = :g3pk, GSI3SK = :g3sk'
          : 'SET paymentsCompleted = :pc, #status = :active, consecutiveFailures = :zero, nextChargeDate = :ncd, lastChargeResult = :lcr, updatedAt = :now, GSI3PK = :g3pk, GSI3SK = :g3sk'),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pc': paymentsCompleted,
        ':completed': 'completed',
        ':active': 'active',
        ':zero': 0,
        ':ncd': newNextChargeDate.toISOString(),
        ':tm': monthKey(addMonths(currentTargetMonthDate, 1)),
        ':lcr': { at: nowIso, ccode: result.ccode, hypTransactionId: result.transactionId ?? null, success: true },
        ':now': nowIso,
        ':g3pk': 'AGREEMENT_STATUS#active',
        ':g3sk': newNextChargeDate.toISOString(),
      },
    }));
  } else {
    if (agreement.kind === 'subscription' && agreement.targetMonth) {
      // Also closes out whatever membership the member currently has —
      // there's no successful charge to hang a new one off of.
      await handlePaymentFailure(agreement.userId, agreement.targetMonth);
    }

    const transactionType: PaymentFailureTransactionType =
      agreement.kind === 'subscription' ? 'subscription_renewal' : 'installment_payment';

    if (!agreement.token) {
      // No card on file at all — nothing to retry via the decline counter.
      // Leave the agreement active and waiting (same nextChargeDate, so it's
      // picked up again tomorrow); the member fixing their card unblocks it.
      // This retries every day until fixed, so admins are only paged once
      // (noCardAdminNotified) rather than nightly forever.
      if (!agreement.noCardAdminNotified) {
        await notifyAdminsPaymentFailed({
          userId: agreement.userId,
          userName: chargeClientName,
          transactionType,
          itemName: agreement.productName,
          amount: chargeAmount,
          ccode: result.ccode,
          hadCardOnFile: false,
          sourceId: agreement.agreementId,
        });
      }

      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: agreement.PK, SK: agreement.SK },
        UpdateExpression: 'SET lastChargeResult = :lcr, updatedAt = :now, noCardAdminNotified = :true',
        ExpressionAttributeValues: {
          ':lcr': { at: nowIso, ccode: result.ccode, hypTransactionId: null, success: false },
          ':now': nowIso,
          ':true': true,
        },
      }));
    } else {
      const consecutiveFailures = agreement.consecutiveFailures + 1;
      const giveUp = consecutiveFailures >= 2;

      await notifyAdminsPaymentFailed({
        userId: agreement.userId,
        userName: chargeClientName,
        transactionType,
        itemName: agreement.productName,
        amount: chargeAmount,
        ccode: result.ccode,
        hadCardOnFile: true,
        sourceId: agreement.agreementId,
      });

      if (giveUp) {
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `MEMBER#${agreement.userId}`, SK: 'PROFILE' },
          UpdateExpression: 'SET admin = :admin',
          ExpressionAttributeValues: { ':admin': { alertMessage: 'התשלום האחרון נכשל, אנא צרו קשר לעדכון פרטי האשראי', hasUnreadAlert: true } },
        })).catch(() => {});
      }

      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: agreement.PK, SK: agreement.SK },
        UpdateExpression: giveUp
          ? 'SET consecutiveFailures = :cf, #status = :failed, lastChargeResult = :lcr, updatedAt = :now REMOVE nextChargeDate, GSI3PK, GSI3SK'
          : 'SET consecutiveFailures = :cf, #status = :active, nextChargeDate = :now, lastChargeResult = :lcr, updatedAt = :now, GSI3PK = :g3pk, GSI3SK = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':cf': consecutiveFailures,
          ':failed': 'failed',
          ':active': 'active',
          ':lcr': { at: nowIso, ccode: result.ccode, hypTransactionId: null, success: false },
          ':now': nowIso,
          ':g3pk': 'AGREEMENT_STATUS#active',
        },
      }));
    }
  }

  return { success: result.success, ccode: result.ccode };
}

export async function runHypBillingCycle(): Promise<{ processed: number; succeeded: number; failed: number }> {
  const nowIso = new Date().toISOString();
  const dueRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk AND GSI3SK <= :now',
    ExpressionAttributeValues: { ':pk': 'AGREEMENT_STATUS#active', ':now': nowIso },
  }));
  const due = (dueRes.Items ?? []) as HypBillingAgreementItem[];

  let succeeded = 0;
  let failed = 0;
  for (const agreement of due) {
    const { success } = await chargeOneAgreement(agreement);
    if (success) succeeded++; else failed++;
  }

  console.log(`[chargeHypBillingAgreements] processed=${due.length} succeeded=${succeeded} failed=${failed}`);
  return { processed: due.length, succeeded, failed };
}

// ── Bridge: link an already-saved token to a plan that has no billing
// agreement yet — an admin-assigned pending_membership, or an active
// membership that was itself granted from a subscription purchase but never
// got its own agreement (e.g. admin-granted). This never charges anything;
// it only creates the agreement (targeting the 1st of next month) so the
// existing cron above picks it up exactly like any organically-created one.
// Called from adminUpdatePendingMembership.ts, adminCreateUser.ts (both
// after writing pending_membership), and hypPaymentGrant.ts (after any
// order refreshes the member's saved token) — see entities.ts's
// HypBillingAgreementItem.bridgedFrom for the audit trail this leaves.
export async function bridgeTokenToBillingAgreement(userId: string): Promise<void> {
  try {
    const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${userId}`, SK: 'PROFILE' } }));
    const member = memberRes.Item as MemberProfileItem | undefined;
    const payment = member?.payment;
    if (!payment?.hypToken || !payment.hypTokenExpiryMonth || !payment.hypTokenExpiryYear) return;

    // Last day of the token's expiry month, end of day — a token is usable
    // through the end of its printed expiry month, same as any card.
    const tokenExpiryEnd = new Date(payment.hypTokenExpiryYear, payment.hypTokenExpiryMonth, 0, 23, 59, 59, 999);
    if (tokenExpiryEnd < new Date()) {
      console.log(`[bridgeTokenToBillingAgreement] user=${userId} skip: saved token expired ${payment.hypTokenExpiryMonth}/${payment.hypTokenExpiryYear}`);
      return;
    }

    // Already has an open subscription agreement (organic or previously
    // bridged) — nothing to do. Makes this safe to call repeatedly from
    // every hook site without ever creating a duplicate.
    const existing = await queryOpenAgreementsForMember(userId, 'subscription');
    if (existing.length > 0) return;

    let productId: string | undefined;
    let productName: string | undefined;
    let description: string | undefined;
    let price = 0;
    let bridgedFrom: NonNullable<HypBillingAgreementItem['bridgedFrom']> | undefined;

    const pendingPlanId = member?.pending_membership?.type;
    if (pendingPlanId) {
      const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${pendingPlanId}`, SK: 'METADATA' } }));
      const product = productRes.Item as ProductItem | undefined;
      if (product && product.type === 'subscription' && product.active !== false) {
        productId = pendingPlanId;
        productName = product.name ?? '';
        description = product.description;
        price = product.price ?? 0;
        bridgedFrom = 'pending_membership';
      }
    }

    if (!productId) {
      const membershipRes = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `MEMBER#${userId}`, ':prefix': 'MEMBERSHIP#' },
      }));
      const memberships = (membershipRes.Items ?? []) as (MembershipItem & { createdAt?: string; productId?: string; productName?: string })[];
      const active = memberships
        .filter((m) => m.status === 'ACTIVE' && m.isAutoRenew && m.productId)
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
      if (active) {
        productId = active.productId;
        productName = active.productName ?? '';
        bridgedFrom = 'active_membership';
      }
    }

    if (!productId || !bridgedFrom) return;

    const agreementId = randomUUID();
    const nowIso = new Date().toISOString();
    const nextChargeDate = firstOfNextMonth(new Date());

    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `AGREEMENT#${agreementId}`,
        SK: 'METADATA',
        GSI1PK: `MEMBER#${userId}`,
        GSI1SK: `AGREEMENT#subscription#${agreementId}`,
        GSI2PK: 'AGREEMENT',
        GSI2SK: `${nowIso}#${agreementId}`,
        GSI3PK: 'AGREEMENT_STATUS#active',
        GSI3SK: nextChargeDate.toISOString(),
        agreementId,
        userId,
        status: 'active',
        kind: 'subscription',
        productId,
        productName,
        ...(description ? { description } : {}),
        token: payment.hypToken,
        tokenExpiryMonth: payment.hypTokenExpiryMonth,
        tokenExpiryYear: payment.hypTokenExpiryYear,
        amountPerCharge: price,
        totalPayments: (await getPolicySettings()).standingOrderMonths,
        paymentsCompleted: 0,
        nextChargeDate: nextChargeDate.toISOString(),
        targetMonth: monthKey(nextChargeDate),
        consecutiveFailures: 0,
        sourceOrderId: 'BRIDGED',
        bridgedFrom,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    }));

    if (bridgedFrom === 'pending_membership') {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: 'PROFILE' },
        UpdateExpression: 'REMOVE pending_membership',
      }));
    }

    console.log(`[bridgeTokenToBillingAgreement] user=${userId} bridged agreement=${agreementId} product=${productId} source=${bridgedFrom} nextChargeDate=${nextChargeDate.toISOString()}`);
  } catch (err: any) {
    console.error(`[bridgeTokenToBillingAgreement] user=${userId} failed:`, err);
  }
}
