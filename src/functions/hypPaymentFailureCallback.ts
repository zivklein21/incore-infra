import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { HypOrderItem } from '../lib/entities';
import { verifyHypTransaction } from '../lib/hypClient';
import { markOrderFailedAndNotifyAdmins } from '../lib/hypPaymentGrant';

const APP_REDIRECT_SCHEME = 'incore://payment-complete';

// GET /hypPaymentFailureCallback
// Auth: NONE — public. Configure this as the "Failed Transaction" custom
// link in the HYP merchant portal. HYP redirects browsers here when the
// card issuer declines the charge.
//
// Public + unauthenticated means anyone could otherwise hit this URL
// directly with a guessed Order id to try to prematurely fail someone
// else's still-pending transaction — calling verifyHypTransaction here
// (even though the outcome is already implied by which URL we're on) is
// what stops that: only a request HYP itself genuinely signed is acted on.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const q = event.queryStringParameters ?? {};
  const orderId = q.Order ?? '';

  const redirectTo = (status: 'success' | 'failed' | 'error'): APIGatewayProxyStructuredResultV2 => ({
    statusCode: 302,
    headers: { Location: `${APP_REDIRECT_SCHEME}?status=${status}&orderId=${encodeURIComponent(orderId)}` },
  });

  if (!orderId) {
    console.error('[hypPaymentFailureCallback] missing Order param in redirect');
    return redirectTo('error');
  }

  const orderKey = { PK: `ORDER#${orderId}`, SK: 'METADATA' };

  try {
    const orderRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: orderKey }));
    const order = orderRes.Item as HypOrderItem | undefined;
    if (!order) {
      console.error(`[hypPaymentFailureCallback] unknown order ${orderId}`);
      return redirectTo('error');
    }

    // ── Idempotent replay guard ────────────────────────────────────────────
    if (order.status !== 'pending') {
      return redirectTo(order.status === 'completed' ? 'success' : 'failed');
    }

    // ── Verify with HYP — confirms this redirect is genuinely from HYP
    // before acting on it (see the security note above). The outcome here
    // is already implied by which URL HYP chose to redirect to, so unlike
    // the success endpoint this doesn't need to branch on ccode — only on
    // whether the redirect is authentic at all.
    const { verified, fields } = await verifyHypTransaction(q as Record<string, string>);
    const ccode = Number(fields.CCode ?? q.CCode);

    console.log(`[hypPaymentFailureCallback] order=${orderId} raw redirect query:`, JSON.stringify(q));
    console.log(`[hypPaymentFailureCallback] order=${orderId} raw VERIFY fields:`, JSON.stringify(fields));

    if (!verified) {
      console.error(`[hypPaymentFailureCallback] order=${orderId} redirect failed signature verification — ignoring`);
      return redirectTo('error');
    }

    await markOrderFailedAndNotifyAdmins(order, orderId, orderKey, Number.isFinite(ccode) ? ccode : -1);
    return redirectTo('failed');
  } catch (err: any) {
    console.error(`[hypPaymentFailureCallback] error processing order ${orderId}:`, err);
    return redirectTo('error');
  }
}
