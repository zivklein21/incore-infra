import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypOrderItem } from '../lib/entities';
import { refundHypTransaction } from '../lib/hypClient';
import { revokePunchCardCredit } from '../lib/punchCards';

// POST /adminRefundMemberLastPayment
// Auth: Cognito JWT, caller must be admin
// Body: { memberId: string, amount?: number }
// Refunds the member's most recent COMPLETED order — full amount by default,
// or a partial amount if provided.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; amount?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_fields', required: ['memberId'] });

  // Most recent orders for this member, newest first, via GSI1
  // (GSI1PK=MEMBER#<uid>, GSI1SK=ORDER#<createdAtIso>#<orderId>).
  const ordersRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'ORDER#' },
    ScanIndexForward: false,
    Limit: 25,
  }));
  const order = ((ordersRes.Items ?? []) as HypOrderItem[]).find((o) => o.status === 'completed');
  if (!order) return json(404, { error: 'no_completed_order' });
  if (!order.hypTransactionId) return json(400, { error: 'missing_transaction_id' });

  // Memberships are never refunded — only a one-off shop purchase is.
  if (order.productType === 'subscription' || order.productType === 'mid_month') {
    return json(400, { error: 'membership_not_refundable' });
  }

  const refundAmount = typeof body.amount === 'number' && body.amount > 0 ? body.amount : order.amount;
  if (refundAmount > order.amount) return json(400, { error: 'amount_exceeds_original' });

  let result;
  try {
    result = await refundHypTransaction(order.hypTransactionId, refundAmount);
  } catch (err: any) {
    console.error(`[adminRefundMemberLastPayment] member=${memberId} order=${order.orderId} threw:`, err);
    result = { success: false, ccode: -1 };
  }

  if (!result.success) return json(402, { success: false, error: 'refund_failed', ccode: result.ccode });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: order.PK, SK: order.SK },
    UpdateExpression: 'SET #status = :refunded, refundedAmount = :amt, refundedAt = :now, refundedBy = :by, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':refunded': 'refunded', ':amt': refundAmount, ':now': new Date().toISOString(), ':by': callerUid },
  }));

  try {
    await revokePunchCardCredit(order);
  } catch (err) {
    console.error(`[adminRefundMemberLastPayment] member=${memberId} order=${order.orderId} refunded but failed to revoke punch-card credit:`, err);
  }

  console.log(`[adminRefundMemberLastPayment] member=${memberId} order=${order.orderId} amount=${refundAmount} by ${callerUid}`);
  return json(200, { success: true, orderId: order.orderId, amount: refundAmount });
}
