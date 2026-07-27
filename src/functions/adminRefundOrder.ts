import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypOrderItem } from '../lib/entities';
import { refundHypTransaction } from '../lib/hypClient';
import { revokePunchCardCredit } from '../lib/punchCards';

// POST /adminRefundOrder
// Auth: Cognito JWT, caller must be admin
// Body: { orderId: string, amount?: number }
// Refunds one specific completed shop-purchase order — used by the All
// Transactions dashboard. Memberships are never refundable.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { orderId?: unknown; amount?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId) return json(400, { error: 'missing_fields', required: ['orderId'] });

  const key = { PK: `ORDER#${orderId}`, SK: 'METADATA' };
  const orderRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const order = orderRes.Item as HypOrderItem | undefined;
  if (!order) return json(404, { error: 'order_not_found' });
  if (order.status !== 'completed') return json(400, { error: 'order_not_refundable' });
  if (order.productType === 'subscription' || order.productType === 'mid_month') {
    return json(400, { error: 'membership_not_refundable' });
  }
  if (!order.hypTransactionId) return json(400, { error: 'missing_transaction_id' });

  const refundAmount = typeof body.amount === 'number' && body.amount > 0 ? body.amount : order.amount;
  if (refundAmount > order.amount) return json(400, { error: 'amount_exceeds_original' });

  let result;
  try {
    result = await refundHypTransaction(order.hypTransactionId, refundAmount);
  } catch (err: any) {
    console.error(`[adminRefundOrder] order=${orderId} threw:`, err);
    result = { success: false, ccode: -1 };
  }

  if (!result.success) return json(402, { success: false, error: 'refund_failed', ccode: result.ccode });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET #status = :refunded, refundedAmount = :amt, refundedAt = :now, refundedBy = :by, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':refunded': 'refunded', ':amt': refundAmount, ':now': new Date().toISOString(), ':by': callerUid },
  }));

  try {
    await revokePunchCardCredit(order);
  } catch (err) {
    console.error(`[adminRefundOrder] order=${orderId} refunded but failed to revoke punch-card credit:`, err);
  }

  console.log(`[adminRefundOrder] order=${orderId} amount=${refundAmount} by ${callerUid}`);
  return json(200, { success: true, orderId, amount: refundAmount });
}
