import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { HypOrderItem } from '../lib/entities';
import { verifyHypTransaction } from '../lib/hypClient';
import { applyHypPaymentSuccess, markOrderFailedAndNotifyAdmins } from '../lib/hypPaymentGrant';

const APP_REDIRECT_SCHEME = 'incore://payment-complete';

// GET /hypPaymentSuccessCallback
// Auth: NONE — public. Configure this as the "Success page URL" in the HYP
// merchant portal. HYP redirects here with Id/CCode/Amount/ACode/Order/Sign
// after the hosted page completes with an approval — but a signed redirect
// only proves authenticity, not approval, so this still verifies the real
// outcome before granting anything (see the `approved` check below).
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const q = event.queryStringParameters ?? {};
  const orderId = q.Order ?? '';

  const redirectTo = (status: 'success' | 'failed' | 'error'): APIGatewayProxyStructuredResultV2 => ({
    statusCode: 302,
    headers: { Location: `${APP_REDIRECT_SCHEME}?status=${status}&orderId=${encodeURIComponent(orderId)}` },
  });

  if (!orderId) {
    console.error('[hypPaymentSuccessCallback] missing Order param in redirect');
    return redirectTo('error');
  }

  const orderKey = { PK: `ORDER#${orderId}`, SK: 'METADATA' };

  try {
    const orderRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: orderKey }));
    const order = orderRes.Item as HypOrderItem | undefined;
    if (!order) {
      console.error(`[hypPaymentSuccessCallback] unknown order ${orderId}`);
      return redirectTo('error');
    }

    // ── Idempotent replay guard ────────────────────────────────────────────
    if (order.status !== 'pending') {
      return redirectTo(order.status === 'completed' ? 'success' : 'failed');
    }

    // ── Verify with HYP — never trust the raw redirect params alone ──────
    const { verified, fields } = await verifyHypTransaction(event.rawQueryString);
    const ccode = Number(fields.CCode ?? q.CCode);

    console.log(`[hypPaymentSuccessCallback] order=${orderId} raw redirect query:`, JSON.stringify(q));
    console.log(`[hypPaymentSuccessCallback] order=${orderId} raw VERIFY fields:`, JSON.stringify(fields));

    // Safety fallback — `verified` only confirms HYP genuinely signed this
    // redirect, not that the charge was approved. Even on the *success*
    // URL, a genuinely-signed decline must still be treated as a failure.
    const approved = verified && Number.isFinite(ccode) && ccode === 0;

    if (!approved) {
      await markOrderFailedAndNotifyAdmins(order, orderId, orderKey, Number.isFinite(ccode) ? ccode : -1);
      return redirectTo('failed');
    }

    const hypTransactionId = fields.Id ?? q.Id ?? '';
    await applyHypPaymentSuccess(order, orderId, orderKey, hypTransactionId, ccode);
    return redirectTo('success');
  } catch (err: any) {
    console.error(`[hypPaymentSuccessCallback] error processing order ${orderId}:`, err);
    return redirectTo('error');
  }
}
