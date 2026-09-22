import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MerchOrderItem } from '../lib/entities';
import { refundHypTransaction } from '../lib/hypClient';
import { restockVariant } from '../lib/merchStock';

// POST /adminRefundMerchOrder
// Body: { orderId: string, amount?: number }
// Auth: Cognito JWT, caller must be admin
// Mirrors adminRefundOrder.ts's shape exactly, scoped to MerchOrderItem/the
// FORCA table — refunds via the same shared HYP account, then restocks the
// purchased variant (no-op if the product/variant was since deleted).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { orderId?: unknown; amount?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId) return json(400, { error: 'missing_fields', required: ['orderId'] });

  const key = { PK: `MERCHORDER#${orderId}`, SK: 'METADATA' };
  const orderRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const order = orderRes.Item as MerchOrderItem | undefined;
  if (!order) return json(404, { error: 'order_not_found' });
  if (order.status !== 'completed') return json(400, { error: 'order_not_refundable' });
  if (!order.hypTransactionId) return json(400, { error: 'missing_transaction_id' });

  const refundAmount = typeof body.amount === 'number' && body.amount > 0 ? body.amount : order.amount;
  if (refundAmount > order.amount) return json(400, { error: 'amount_exceeds_original' });

  let result;
  try {
    result = await refundHypTransaction(order.hypTransactionId, refundAmount);
  } catch (err: any) {
    console.error(`[adminRefundMerchOrder] order=${orderId} threw:`, err);
    result = { success: false, ccode: -1 };
  }
  if (!result.success) return json(402, { success: false, error: 'refund_failed', ccode: result.ccode });

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET #status = :refunded, refundedAmount = :amt, refundedAt = :now, refundedBy = :by, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':refunded': 'refunded', ':amt': refundAmount, ':now': new Date().toISOString(), ':by': callerUid },
  }));

  try {
    await Promise.all(order.items.map((item) => restockVariant(item.merchProductId, item.merchVariantId, item.quantity)));
  } catch (err) {
    console.error(`[adminRefundMerchOrder] order=${orderId} refunded but failed to restock one or more items:`, err);
  }

  console.log(`[adminRefundMerchOrder] order=${orderId} amount=${refundAmount} by ${callerUid}`);
  return json(200, { success: true, orderId, amount: refundAmount });
}
