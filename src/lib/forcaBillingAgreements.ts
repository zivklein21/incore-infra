import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ForcaBillingAgreementItem, ForcaSubscriptionOrderItem, MemberProfileItem } from './entities';
import { endOfMonth, firstOfNextMonth } from './entities';
import { chargeHypToken } from './hypClient';
import { getMemberIdNumber, getMemberFullName, buildHypInfo, HYP_NO_ID_PLACEHOLDER } from './hypOrders';
import { getExpoPushToken, sendExpoPush } from './push';
// Admin accounts only ever live in the INCORE table (isAdmin() itself always
// checks TABLE_NAME — see lib/auth.ts) — there is no separate "FORCA admin"
// identity, so admin payment-failure alerts reuse this INCORE-table helper
// as-is rather than a FORCA-table copy, unlike every other piece of this
// feature.
import { notifyAdminsPaymentFailed } from './adminNotify';

// FORCA's own recurring-billing engine — a direct simplification of
// hypBillingAgreements.ts's chargeOneAgreement/runHypBillingCycle for
// ForcaBillingAgreementItem (no totalPayments/installments concept; see
// entities.ts's doc comment for why). Charges lib/hypClient.ts's shared
// chargeHypToken — both brands use the same HYP merchant account, see
// hypClient.ts's own credentials comment. Used by both the daily cron
// (chargeForcaSubscriptions.ts) and any future admin "charge now" override.
export async function chargeOneForcaAgreement(agreement: ForcaBillingAgreementItem): Promise<{ success: boolean; ccode: number }> {
  const payerRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${agreement.payerUid}`, SK: 'PROFILE' } }));
  const payer = payerRes.Item as MemberProfileItem | undefined;
  const chargeUserId = (payer && getMemberIdNumber(payer)) || HYP_NO_ID_PLACEHOLDER;
  const chargeClientName = payer ? getMemberFullName(payer) : agreement.payerName || 'Parent';
  const chargeEmail = payer?.identity?.email || payer?.email || '';

  let result: { success: boolean; ccode: number; transactionId?: string; authCode?: string };
  if (!agreement.token) {
    // No card on file (shouldn't normally happen — a FORCA agreement is
    // never created without one — but defensive, same failure path as a
    // real decline below: retries daily, pages admins once).
    result = { success: false, ccode: -1 };
  } else {
    try {
      result = await chargeHypToken({
        token: agreement.token,
        expiryMonth: agreement.tokenExpiryMonth,
        expiryYear: agreement.tokenExpiryYear,
        amount: agreement.amountPerCharge,
        userId: chargeUserId,
        clientName: chargeClientName,
        info: buildHypInfo(agreement.productName, `שם הילדה: ${agreement.groupName}`),
        email: chargeEmail || undefined,
        sendReceipt: true,
      });
    } catch (err: any) {
      console.error(`[chargeOneForcaAgreement] agreement=${agreement.agreementId} charge threw:`, err);
      result = { success: false, ccode: -1 };
    }
  }

  const nowIso = new Date().toISOString();

  if (result.success) {
    const orderId = randomUUID();
    const order: ForcaSubscriptionOrderItem = {
      PK: `FORCASUBORDER#${orderId}`,
      SK: 'METADATA',
      GSI1PK: `MEMBER#${agreement.userId}`,
      GSI1SK: `FORCASUBORDER#${nowIso}#${orderId}`,
      GSI2PK: 'FORCASUBORDER',
      GSI2SK: `${nowIso}#${orderId}`,
      orderId,
      userId: agreement.userId,
      status: 'completed',
      subscriptionProductId: agreement.subscriptionProductId,
      productName: agreement.productName,
      groupId: agreement.groupId,
      groupName: agreement.groupName,
      amount: agreement.amountPerCharge,
      ...(result.transactionId ? { hypTransactionId: result.transactionId } : {}),
      hypCCode: result.ccode,
      billingAgreementId: agreement.agreementId,
      createdAt: nowIso,
      updatedAt: nowIso,
      verifiedAt: nowIso,
      payerUid: agreement.payerUid,
      payerName: agreement.payerName,
    };
    await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: order }));

    // Extend access one more month — same membership-window shape
    // adminGrantForcaMembership.ts writes, see GroupItem's doc comment.
    // identity.groupId is resent every month too (idempotent) in case an
    // admin ever moved the trainee to a different group in the meantime —
    // a subscription always keeps mapping her back to its own group.
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MEMBER#${agreement.userId}`, SK: 'PROFILE' },
      UpdateExpression: 'SET #identity.groupId = :gid, membership = :membership',
      ExpressionAttributeNames: { '#identity': 'identity' },
      ExpressionAttributeValues: {
        ':gid': agreement.groupId,
        ':membership': {
          title: agreement.groupName,
          start: nowIso,
          end: endOfMonth(new Date()).toISOString(),
          grantedBy: `subscription:${agreement.agreementId}`,
          grantedAt: nowIso,
        },
      },
    }));

    const newNextChargeDate = firstOfNextMonth(new Date());
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: agreement.PK, SK: agreement.SK },
      UpdateExpression: 'SET #status = :active, consecutiveFailures = :zero, nextChargeDate = :ncd, lastChargeResult = :lcr, updatedAt = :now, GSI3PK = :g3pk, GSI3SK = :g3sk',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':zero': 0,
        ':ncd': newNextChargeDate.toISOString(),
        ':lcr': { at: nowIso, ccode: result.ccode, hypTransactionId: result.transactionId ?? null, success: true },
        ':now': nowIso,
        ':g3pk': 'FORCA_AGREEMENT_STATUS#active',
        ':g3sk': newNextChargeDate.toISOString(),
      },
    }));
  } else {
    // Deliberately does NOT touch the trainee's membership window on
    // failure — whatever's left of the last successfully-paid period stays
    // valid and lapses naturally; a failed renewal simply grants nothing
    // new, it never forcibly revokes what's already been paid for.
    if (!agreement.token) {
      if (!agreement.noCardAdminNotified) {
        await notifyAdminsPaymentFailed({
          userId: agreement.userId,
          userName: agreement.payerName || chargeClientName,
          transactionType: 'subscription_renewal',
          itemName: agreement.productName,
          amount: agreement.amountPerCharge,
          ccode: result.ccode,
          hadCardOnFile: false,
          sourceId: agreement.agreementId,
        });
      }
      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
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
        userName: agreement.payerName || chargeClientName,
        transactionType: 'subscription_renewal',
        itemName: agreement.productName,
        amount: agreement.amountPerCharge,
        ccode: result.ccode,
        hadCardOnFile: true,
        sourceId: agreement.agreementId,
      });

      await notifyPayerCardDeclined(agreement, giveUp);

      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
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
          ':g3pk': 'FORCA_AGREEMENT_STATUS#active',
        },
      }));
    }
  }

  return { success: result.success, ccode: result.ccode };
}

// Parent-facing alert — a push notification plus the same MESSAGE# inbox
// item subscriptionExpiryAlert.ts writes on the member's own PROFILE item
// (read by the app's in-app notifications feed). Deliberately not routed
// through lib/templateResolver.ts's admin-configurable template system —
// that machinery exists for member-facing marketing-style copy an admin
// wants to customize per language; a card-declined alert is a fixed,
// urgent, single-purpose message that must always go out verbatim.
async function notifyPayerCardDeclined(agreement: ForcaBillingAgreementItem, gaveUp: boolean): Promise<void> {
  try {
    const payerRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${agreement.payerUid}`, SK: 'PROFILE' } }));
    const payer = payerRes.Item as MemberProfileItem | undefined;
    if (!payer) return;

    const title = gaveUp ? '⚠️ המנוי הופסק' : '⚠️ תשלום המנוי נכשל';
    const body = gaveUp
      ? `החיוב עבור המנוי "${agreement.productName}" נכשל פעמיים ברציפות והמנוי הופסק. עדכני פרטי אשראי כדי להפעיל אותו מחדש.`
      : `החיוב עבור המנוי "${agreement.productName}" נכשל החודש. ננסה לחייב שוב מחר — כדאי לוודא שפרטי האשראי מעודכנים.`;

    const nowIso = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: {
        PK: `MEMBER#${agreement.payerUid}`,
        SK: `MESSAGE#forcasub_failed_${agreement.agreementId}_${nowIso}`,
        type: 'admin_alert',
        title,
        body,
        createdAt: nowIso,
        requiresAction: false,
        read: false,
      },
    }));

    const token = getExpoPushToken(payer);
    if (token) await sendExpoPush(token, title, body, { screen: 'ForcaTabs', initialTab: 'profile' });
  } catch (err: any) {
    console.error(`[notifyPayerCardDeclined] agreement=${agreement.agreementId} failed:`, err);
  }
}

// Shared status-transition logic for freeze/unfreeze/cancel — used by both
// adminSetForcaBillingAgreementStatus.ts (admin) and
// setForcaSubscriptionFreeze.ts/cancelForcaSubscription.ts (parent), which
// differ only in how they authorize the caller. See entities.ts's
// ForcaBillingAgreementItem comment for why 'frozen' is just dropping GSI3
// (same as INCORE's 'paused') and why 'cancelled' never touches
// profile.membership.
export async function setForcaAgreementStatus(
  agreement: ForcaBillingAgreementItem,
  status: 'active' | 'frozen' | 'cancelled',
): Promise<void> {
  const key = { PK: agreement.PK, SK: agreement.SK };
  const nowIso = new Date().toISOString();

  if (status === 'active') {
    const current = agreement.nextChargeDate;
    const nextChargeDate = (!current || new Date(current) < new Date()) ? firstOfNextMonth(new Date()).toISOString() : current;
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET #status = :active, consecutiveFailures = :zero, updatedAt = :now, nextChargeDate = :ncd, GSI3PK = :g3pk, GSI3SK = :ncd',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':zero': 0, ':now': nowIso, ':ncd': nextChargeDate, ':g3pk': 'FORCA_AGREEMENT_STATUS#active' },
    }));
  } else if (status === 'frozen') {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET #status = :status, consecutiveFailures = :zero, updatedAt = :now REMOVE GSI3PK, GSI3SK',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':zero': 0, ':now': nowIso },
    }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET #status = :status, updatedAt = :now, token = :empty REMOVE GSI3PK, GSI3SK, nextChargeDate',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':now': nowIso, ':empty': '' },
    }));
  }
}

export async function runForcaBillingCycle(): Promise<{ processed: number; succeeded: number; failed: number }> {
  const nowIso = new Date().toISOString();
  const dueRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk AND GSI3SK <= :now',
    ExpressionAttributeValues: { ':pk': 'FORCA_AGREEMENT_STATUS#active', ':now': nowIso },
  }));
  const due = (dueRes.Items ?? []) as ForcaBillingAgreementItem[];

  let succeeded = 0;
  let failed = 0;
  for (const agreement of due) {
    const { success } = await chargeOneForcaAgreement(agreement);
    if (success) succeeded++; else failed++;
  }

  console.log(`[chargeForcaSubscriptions] processed=${due.length} succeeded=${succeeded} failed=${failed}`);
  return { processed: due.length, succeeded, failed };
}
