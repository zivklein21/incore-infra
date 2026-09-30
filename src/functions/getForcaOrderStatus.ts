import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ForcaSubscriptionOrderItem, MerchOrderItem } from '../lib/entities';

// GET /getForcaOrderStatus?orderId=xxx
// Auth: Cognito JWT (must be the order's own trainee or payer)
// Response: { status: 'pending' | 'completed' | 'failed' | 'not_found' }
//
// A lightweight poll target for HypPaymentWebView.tsx's belt-and-braces
// status check. The redirect-detection paths (onShouldStartLoadWithRequest/
// onNavigationStateChange/onError, plus a Linking listener) usually catch a
// completed payment within the WebView instantly — but some WebView
// engine/platform combinations can silently swallow a 3xx redirect to a
// custom (incore://) scheme without ever surfacing it to JS at all, not
// even as a Linking event, leaving the payment modal open forever despite
// the charge having genuinely gone through server-side. Polling this
// endpoint directly is the one signal that doesn't depend on that redirect
// being detected client-side at all.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const orderId = event.queryStringParameters?.orderId ?? '';
  if (!orderId) return json(400, { error: 'missing_order_id' });

  const prefix = orderId.startsWith('forcasub-') ? 'FORCASUBORDER#' : orderId.startsWith('merch-') ? 'MERCHORDER#' : null;
  if (!prefix) return json(400, { error: 'invalid_order_id' });

  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `${prefix}${orderId}`, SK: 'METADATA' } }));
  const order = res.Item as (ForcaSubscriptionOrderItem | MerchOrderItem) | undefined;
  if (!order) return json(200, { status: 'not_found' });

  // Only the trainee the order is for, or the parent who paid for it, may
  // poll its status — same authorization shape as verifyFamilyLink's
  // callers, no admin bypass needed here.
  if (order.userId !== callerUid && order.payerUid !== callerUid) return json(403, { error: 'forbidden' });

  const status = order.status === 'completed' ? 'completed' : order.status === 'failed' ? 'failed' : 'pending';
  return json(200, { status });
}
