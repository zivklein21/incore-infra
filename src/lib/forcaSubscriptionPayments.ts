// Self-contained HYP success-redirect handling for a FORCA subscription's
// FIRST charge — entirely separate from hypPaymentCallback.ts's own
// INCORE-order logic, same "own file, never threaded into the shared
// handler" reasoning as lib/merchPayments.ts. See entities.ts's
// ForcaSubscriptionOrderItem/ForcaBillingAgreementItem comments.

import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ForcaBillingAgreementItem, ForcaSubscriptionOrderItem, MemberProfileItem } from './entities';
import { endOfMonth, firstOfNextMonth } from './entities';
import { verifyHypTransaction, getHypToken, inquireCardBrand } from './hypClient';
import { recordSystemAlert } from './alerts';

const APP_REDIRECT_SCHEME = 'incore://payment-complete';

export async function handleForcaSubscriptionOrderCallback(
  orderId: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const redirectTo = (status: 'success' | 'failed' | 'error'): APIGatewayProxyStructuredResultV2 => ({
    statusCode: 302,
    headers: { Location: `${APP_REDIRECT_SCHEME}?status=${status}&orderId=${encodeURIComponent(orderId)}` },
  });

  const orderKey = { PK: `FORCASUBORDER#${orderId}`, SK: 'METADATA' };

  try {
    const orderRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: orderKey }));
    const order = orderRes.Item as ForcaSubscriptionOrderItem | undefined;
    if (!order) {
      console.error(`[forcaSubscriptionPayments] unknown order ${orderId}`);
      return redirectTo('error');
    }

    // Idempotent replay guard — same reasoning as hypPaymentCallback.ts's own.
    if (order.status !== 'pending') {
      return redirectTo(order.status === 'completed' ? 'success' : 'failed');
    }

    const { verified, fields } = await verifyHypTransaction(event.rawQueryString);
    const q = event.queryStringParameters ?? {};
    const ccode = Number(fields.CCode ?? q.CCode);
    const nowIso = new Date().toISOString();

    // See hypPaymentCallback.ts's identical comment — a correctly-signed
    // redirect for a declined charge is still `verified === true`; the real
    // outcome is `ccode` (0 = approved).
    const approved = verified && Number.isFinite(ccode) && ccode === 0;

    if (!approved) {
      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: orderKey,
        UpdateExpression: 'SET #status = :failed, hypCCode = :ccode, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':failed': 'failed', ':ccode': Number.isFinite(ccode) ? ccode : -1, ':now': nowIso },
      }));
      return redirectTo('failed');
    }

    const hypTransactionId = fields.Id ?? q.Id ?? '';

    // ── Tokenize — the whole point of a subscription purchase over a
    // one-time merch buy. A failed capture here doesn't undo the charge
    // (the parent already paid for this month); it just means no recurring
    // agreement can be created, so this is flagged for manual admin
    // follow-up rather than silently dropped.
    const token = await getHypToken(hypTransactionId);
    let billingAgreementId: string | undefined;

    if (!token) {
      console.warn(`[forcaSubscriptionPayments] getToken failed for order ${orderId}, transId=${hypTransactionId} — no recurring agreement created`);
      await recordSystemAlert({
        severity: 'critical',
        source: 'forcaSubscriptionPayments',
        message: `FORCA subscription order ${orderId} charged successfully but card tokenization failed — no recurring agreement was created, needs manual follow-up with the parent`,
        context: { orderId, userId: order.userId, payerUid: order.payerUid },
      });
    } else {
      const cardBrand = await inquireCardBrand(hypTransactionId);

      // A trainee re-subscribing (new group, or just re-buying) must never
      // end up with two open agreements both billing monthly — cancel
      // whatever old one is still active/frozen first, same "stale
      // agreement supersession" INCORE's own hypPaymentCallback.ts does.
      const staleRes = await ddb.send(new QueryCommand({
        TableName: FORCA_TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        FilterExpression: '#status IN (:active, :frozen)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pk': `MEMBER#${order.userId}`, ':prefix': 'AGREEMENT#', ':active': 'active', ':frozen': 'frozen' },
      }));
      const staleAgreements = (staleRes.Items ?? []) as ForcaBillingAgreementItem[];
      await Promise.all(staleAgreements.map((stale) =>
        ddb.send(new UpdateCommand({
          TableName: FORCA_TABLE_NAME,
          Key: { PK: stale.PK, SK: stale.SK },
          UpdateExpression: 'SET #status = :cancelled, updatedAt = :now, token = :empty REMOVE GSI3PK, GSI3SK, nextChargeDate',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':cancelled': 'cancelled', ':now': nowIso, ':empty': '' },
        })),
      ));

      const agreementId = randomUUID();
      billingAgreementId = agreementId;
      const nextChargeDate = firstOfNextMonth(new Date());

      const agreement: ForcaBillingAgreementItem = {
        PK: `FORCAAGREEMENT#${agreementId}`,
        SK: 'METADATA',
        GSI1PK: `MEMBER#${order.userId}`,
        GSI1SK: `AGREEMENT#${agreementId}`,
        GSI2PK: 'FORCAAGREEMENT',
        GSI2SK: `${nowIso}#${agreementId}`,
        GSI3PK: 'FORCA_AGREEMENT_STATUS#active',
        GSI3SK: nextChargeDate.toISOString(),
        agreementId,
        userId: order.userId,
        payerUid: order.payerUid ?? order.userId,
        payerName: order.payerName ?? '',
        status: 'active',
        subscriptionProductId: order.subscriptionProductId,
        productName: order.productName,
        groupId: order.groupId,
        groupName: order.groupName,
        token: token.token,
        tokenExpiryMonth: token.expiryMonth,
        tokenExpiryYear: token.expiryYear,
        amountPerCharge: order.amount,
        nextChargeDate: nextChargeDate.toISOString(),
        consecutiveFailures: 0,
        sourceOrderId: orderId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: agreement }));

      // Cache the card on the PAYER's own profile (she owns the card, even
      // though the agreement itself is keyed to the trainee) — reference/
      // display only; each agreement's own token is what's actually charged.
      const payerUid = order.payerUid ?? order.userId;
      const payerRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${payerUid}`, SK: 'PROFILE' } }));
      const currentPayment = (payerRes.Item as MemberProfileItem | undefined)?.payment;
      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: { PK: `MEMBER#${payerUid}`, SK: 'PROFILE' },
        UpdateExpression: 'SET payment = :p',
        ExpressionAttributeValues: {
          ':p': {
            ...currentPayment,
            hypToken: token.token,
            hypTokenExpiryMonth: token.expiryMonth,
            hypTokenExpiryYear: token.expiryYear,
            hypTokenUpdatedAt: nowIso,
            hasSavedCard: true,
            ...(cardBrand ? { cardBrand } : {}),
          },
        },
      }));
    }

    // ── Grant access — group mapping + the same membership-window shape
    // adminGrantForcaMembership.ts writes, see GroupItem's doc comment. This
    // happens whether or not tokenization above succeeded: the parent paid
    // for this month, so the trainee gets it regardless.
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' },
      // identity is a DynamoDB reserved keyword — see adminAssignGroup.ts's
      // #identity alias for the same issue.
      UpdateExpression: 'SET #identity.groupId = :gid, membership = :membership',
      ExpressionAttributeNames: { '#identity': 'identity' },
      ExpressionAttributeValues: {
        ':gid': order.groupId,
        ':membership': {
          title: order.groupName,
          start: nowIso,
          end: endOfMonth(new Date()).toISOString(),
          grantedBy: billingAgreementId ? `subscription:${billingAgreementId}` : `subscription:${orderId}`,
          grantedAt: nowIso,
        },
      },
    }));

    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: orderKey,
      UpdateExpression: 'SET #status = :completed, hypTransactionId = :tid, hypCCode = :ccode, verifiedAt = :now, updatedAt = :now'
        + (billingAgreementId ? ', billingAgreementId = :bid' : ''),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':completed': 'completed', ':tid': hypTransactionId, ':ccode': ccode, ':now': nowIso,
        ...(billingAgreementId ? { ':bid': billingAgreementId } : {}),
      },
    }));

    console.log(`[forcaSubscriptionPayments] order=${orderId} user=${order.userId} completed transId=${hypTransactionId} agreement=${billingAgreementId ?? 'none'}`);
    return redirectTo('success');
  } catch (err: any) {
    console.error(`[forcaSubscriptionPayments] error processing order ${orderId}:`, err);
    return redirectTo('error');
  }
}
