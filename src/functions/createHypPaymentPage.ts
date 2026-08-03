import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { buildOrderFromProduct, orderBuildErrorStatus, orderFromBuild, newOrderKey, getMemberIdNumber, HYP_NO_ID_PLACEHOLDER } from '../lib/hypOrders';
import { createHypSignedPaymentUrl, HypSignError } from '../lib/hypClient';

// POST /createHypPaymentPage
// Auth: Cognito JWT
// Body: { productId: string, installments?: number }
// Response: { paymentUrl: string, orderId: string }
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { productId?: unknown; installments?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
  const requestedInstallments = typeof body.installments === 'number' ? body.installments : undefined;
  if (!productId) return json(400, { error: 'missing_fields', required: ['productId'] });

  const result = await buildOrderFromProduct(uid, productId, requestedInstallments);
  if (!result.ok) return json(orderBuildErrorStatus(result.error), { error: result.error });
  const { build, member } = result;

  // A real multi-installment sale (not a subscription/mid-month bridge,
  // neither of which ever set totalAmount) is charged as ONE HYP transaction
  // for the FULL amount, tagged with Tash/TashType — HYP splits the payment
  // with the card issuer itself. Our own scheduler only drives open-ended
  // subscriptions now — see createHypTokenPurchase.ts for the same rule on
  // the saved-card path.
  const isInstallmentSale = build.totalPayments > 1 && build.totalAmount !== undefined;
  const chargeAmount = isInstallmentSale ? build.totalAmount! : build.firstChargeAmount;

  const { PK, SK, orderId } = newOrderKey();
  const order = orderFromBuild(orderId, uid, productId, build);
  order.amount = chargeAmount;
  if (isInstallmentSale) {
    order.installmentsCount = build.totalPayments;
    order.installmentAmount = build.amountPerCharge;
  }
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: order }));

  try {
    const paymentUrl = await createHypSignedPaymentUrl({
      order: orderId,
      amount: chargeAmount,
      tash: isInstallmentSale ? build.totalPayments : 1,
      tashType: 1,
      clientName: build.clientFirstName,
      clientLName: build.clientLastName || undefined,
      email: build.email || undefined,
      cell: build.cell || undefined,
      userId: getMemberIdNumber(member) || HYP_NO_ID_PLACEHOLDER,
      info: build.productName,
      pageLang: 'HEB',
      sendReceipt: true,
    });
    return json(200, {
      paymentUrl,
      orderId,
      amountCharged: chargeAmount,
      ...(isInstallmentSale ? {
        totalAmount: build.totalAmount,
        installmentsCount: build.totalPayments,
        installmentAmount: build.amountPerCharge,
      } : {}),
    });
  } catch (err: any) {
    console.error('[createHypPaymentPage] HYP SIGN call failed:', err);
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK, SK },
      UpdateExpression: 'SET #status = :failed, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed', ':now': new Date().toISOString() },
    }));
    if (err instanceof HypSignError) {
      return json(502, { error: 'hyp_sign_failed', ccode: err.ccode, hypFields: err.fields });
    }
    return json(502, { error: 'hyp_sign_failed' });
  }
}
