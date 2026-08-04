import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem, ProductItem } from '../lib/entities';
import { monthKey, endOfMonth } from '../lib/entities';
import { getMemberIdNumber, getMemberFullName, buildHypInfo, HYP_NO_ID_PLACEHOLDER } from '../lib/hypOrders';
import { chargeHypToken } from '../lib/hypClient';
import { handlePaymentSuccess, handlePaymentFailure, type PaymentSuccessPayload } from '../lib/paymentGrants';

// POST /renewSubscriptionWithToken
// Auth: Cognito JWT
// Body: { productId?: string, targetUserId?: string }
// Manual/supplementary path: charges the saved token immediately instead of
// waiting for the nightly cron. targetUserId requires the caller to be admin.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { productId?: unknown; targetUserId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const requestedTargetUserId = typeof body.targetUserId === 'string' ? body.targetUserId : '';

  let userId = callerUid;
  if (requestedTargetUserId && requestedTargetUserId !== callerUid) {
    if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });
    userId = requestedTargetUserId;
  }

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${userId}`, SK: 'PROFILE' } }));
  const member = memberRes.Item as MemberProfileItem | undefined;
  if (!member) return json(404, { error: 'member_not_found' });

  const payment = member.payment;
  const token = payment?.hypToken ?? '';
  const expiryMonth = payment?.hypTokenExpiryMonth ?? 0;
  const expiryYear = payment?.hypTokenExpiryYear ?? 0;
  if (!token || !expiryMonth || !expiryYear) return json(400, { error: 'no_saved_token' });

  const productId = (typeof body.productId === 'string' && body.productId) || payment?.hypTokenProductId || '';
  if (!productId) return json(400, { error: 'missing_product' });

  const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } }));
  const product = productRes.Item as ProductItem | undefined;
  if (!product) return json(404, { error: 'product_not_found' });
  if (!product.active || product.type !== 'subscription') return json(400, { error: 'invalid_product' });
  const price = product.price ?? 0;
  if (price <= 0) return json(400, { error: 'invalid_price' });

  const clientName = getMemberFullName(member);

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = endOfMonth(start);
  const targetMonth = monthKey(start);

  let result;
  try {
    result = await chargeHypToken({
      token, expiryMonth, expiryYear,
      amount: price,
      userId: getMemberIdNumber(member) || HYP_NO_ID_PLACEHOLDER,
      clientName,
      info: buildHypInfo(product.name ?? productId, product.description),
      email: member.identity?.email || member.email || undefined,
      sendReceipt: true,
    });
  } catch (err: any) {
    console.error(`[renewSubscriptionWithToken] user=${userId} charge threw:`, err);
    result = { success: false, ccode: -1 };
  }

  if (!result.success) {
    await handlePaymentFailure(userId, targetMonth);
    return json(402, { success: false, error: 'charge_failed', ccode: result.ccode });
  }

  const currentPaymentCount = payment?.payment_count ?? 0;

  const payload: PaymentSuccessPayload = {
    event: 'payment_success',
    userId,
    targetMonth,
    productId,
    productName: product.name ?? '',
    productType: 'subscription',
    monthlyLimit: product.monthlyLimit && product.monthlyLimit > 0 ? product.monthlyLimit : product.sessions ?? 0,
    weeklyLimit: product.weeklyLimit && product.weeklyLimit > 0 ? product.weeklyLimit : product.sessions_per_week ?? 0,
    allowedLegalCancellationsPerMonth: product.allowedLegalCancellationsPerMonth ?? 2,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    paymentCount: currentPaymentCount + 1,
  };
  await handlePaymentSuccess(userId, payload);

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${userId}`, SK: 'PROFILE' },
    UpdateExpression: 'SET payment.hypTokenProductId = :pid',
    ExpressionAttributeValues: { ':pid': productId },
  }));

  console.log(`[renewSubscriptionWithToken] user=${userId} product=${productId} month=${targetMonth} triggeredBy=${callerUid}`);
  return json(200, { success: true, targetMonth });
}
