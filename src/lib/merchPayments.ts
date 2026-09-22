// Self-contained HYP success-redirect handling for a merch order — entirely
// separate from hypPaymentCallback.ts's own INCORE-order logic below its
// dispatch branch (subscriptions/installments/billing-agreements/mid-month
// none of which apply to a one-time merch purchase). See entities.ts's
// MerchOrderItem comment for why this exists as its own file instead of
// being threaded into the shared handler.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { MerchOrderItem } from './entities';
import { verifyHypTransaction } from './hypClient';
import { decrementVariantStock } from './merchStock';
import { recordSystemAlert } from './alerts';

const APP_REDIRECT_SCHEME = 'incore://payment-complete';

export async function handleMerchOrderCallback(
  orderId: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const redirectTo = (status: 'success' | 'failed' | 'error'): APIGatewayProxyStructuredResultV2 => ({
    statusCode: 302,
    headers: { Location: `${APP_REDIRECT_SCHEME}?status=${status}&orderId=${encodeURIComponent(orderId)}` },
  });

  const orderKey = { PK: `MERCHORDER#${orderId}`, SK: 'METADATA' };

  try {
    const orderRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: orderKey }));
    const order = orderRes.Item as MerchOrderItem | undefined;
    if (!order) {
      console.error(`[merchPayments] unknown order ${orderId}`);
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

    // One decrement per line item — a cart order can span several
    // different products/variants (see entities.ts's MerchOrderItem).
    const failedItems = (await Promise.all(order.items.map(async (item) => {
      const ok = await decrementVariantStock(item.merchProductId, item.merchVariantId, item.quantity);
      return ok ? null : item;
    }))).filter((item) => item !== null);

    if (failedItems.length > 0) {
      // Payment already succeeded with HYP at this point — never leave that
      // silently untracked. An admin needs to manually resolve this (refund
      // or restock elsewhere), same severity as this file's other failure
      // paths that page admins. One alert for the whole order, listing every
      // affected line item, rather than one alert per item.
      await recordSystemAlert({
        severity: 'critical',
        source: 'merchPayments',
        message: `Merch order ${orderId} charged successfully but ${failedItems.length} line item(s) could not be decremented (sold out or deleted) — needs manual resolution`,
        context: { orderId, userId: order.userId, failedItems },
      });
    }

    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: orderKey,
      UpdateExpression: 'SET #status = :completed, hypTransactionId = :tid, hypCCode = :ccode, verifiedAt = :now, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':completed': 'completed', ':tid': hypTransactionId, ':ccode': ccode, ':now': nowIso },
    }));

    console.log(`[merchPayments] order=${orderId} user=${order.userId} completed transId=${hypTransactionId}`);
    return redirectTo('success');
  } catch (err: any) {
    console.error(`[merchPayments] error processing order ${orderId}:`, err);
    return redirectTo('error');
  }
}
