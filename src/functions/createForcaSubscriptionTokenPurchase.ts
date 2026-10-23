import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getMemberFullName, buildHypInfo, getMemberIdNumber, HYP_NO_ID_PLACEHOLDER } from '../lib/hypOrders';
import { chargeHypToken } from '../lib/hypClient';
import { verifyFamilyLink } from '../lib/familyLinks';
import { applyForcaSubscriptionCharge } from '../lib/forcaSubscriptionPayments';
import type { ForcaSubscriptionOrderItem, ForcaSubscriptionProductItem, GroupItem, MemberProfileItem } from '../lib/entities';

// POST /createForcaSubscriptionTokenPurchase
// Auth: Cognito JWT (any signed-in FORCA member)
// Body: { subscriptionProductId: string, childUid: string }
// Response: { success: true } | 402 { success: false, error: 'charge_failed', ccode }
//
// The saved-card counterpart to createForcaSubscriptionPaymentPage.ts — same
// validation, but charges the PAYER's already-saved HYP token directly (see
// createHypTokenPurchase.ts, INCORE's equivalent) instead of opening a
// hosted page. No redirect/webview involved: the charge either succeeds or
// fails synchronously, right here.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { subscriptionProductId?: unknown; childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const subscriptionProductId = typeof body.subscriptionProductId === 'string' ? body.subscriptionProductId.trim() : '';
  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!subscriptionProductId) return json(400, { error: 'missing_subscription_product' });
  if (!childUid) return json(400, { error: 'missing_child' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const [childRes, payerRes, productRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${childUid}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCASUBPRODUCT#${subscriptionProductId}`, SK: 'METADATA' } })),
  ]);
  const child = childRes.Item as MemberProfileItem | undefined;
  const payer = payerRes.Item as MemberProfileItem | undefined;
  const product = productRes.Item as ForcaSubscriptionProductItem | undefined;
  if (!child) return json(404, { error: 'child_not_found' });
  if (!payer) return json(404, { error: 'payer_not_found' });
  if (!product) return json(404, { error: 'product_not_found' });
  if (!product.active) return json(400, { error: 'product_inactive' });
  if (product.visibility === 'PRIVATE' && !(product.targetParentUids ?? []).includes(callerUid)) return json(403, { error: 'forbidden' });
  if (!(product.price >= 0)) return json(400, { error: 'invalid_price' });

  const savedToken = payer.payment?.hypToken;
  const savedExpiryMonth = payer.payment?.hypTokenExpiryMonth;
  const savedExpiryYear = payer.payment?.hypTokenExpiryYear;
  if (!savedToken || !savedExpiryMonth || !savedExpiryYear) return json(400, { error: 'no_saved_token' });

  const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${product.groupId}`, SK: 'METADATA' } }));
  const group = groupRes.Item as GroupItem | undefined;
  if (!group) return json(404, { error: 'group_not_found' });

  const childName = getMemberFullName(child);
  const orderId = `forcasub-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const order: ForcaSubscriptionOrderItem = {
    PK: `FORCASUBORDER#${orderId}`,
    SK: 'METADATA',
    GSI1PK: `MEMBER#${childUid}`,
    GSI1SK: `FORCASUBORDER#${nowIso}#${orderId}`,
    GSI2PK: 'FORCASUBORDER',
    GSI2SK: `${nowIso}#${orderId}`,
    orderId,
    userId: childUid,
    status: 'pending',
    subscriptionProductId,
    productName: product.name,
    groupId: product.groupId,
    groupName: group.name,
    amount: product.price,
    createdAt: nowIso,
    updatedAt: nowIso,
    childUid,
    childName,
    payerUid: callerUid,
    payerName: getMemberFullName(payer),
  };
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: order }));

  let chargeResult;
  try {
    chargeResult = await chargeHypToken({
      token: savedToken,
      expiryMonth: savedExpiryMonth,
      expiryYear: savedExpiryYear,
      amount: product.price,
      // action=soft (charge a saved token) is a different HYP endpoint from
      // action=APISign — every other chargeHypToken caller in this codebase
      // (chargeOneForcaAgreement, createHypTokenPurchase.ts) sends the
      // placeholder here rather than omitting it, unlike the hosted-page
      // SIGN call this doesn't go through.
      userId: getMemberIdNumber(payer) || HYP_NO_ID_PLACEHOLDER,
      clientName: getMemberFullName(payer),
      info: buildHypInfo(product.name, `שם הילדה: ${childName}`),
      email: payer.identity?.email || payer.email || undefined,
      sendReceipt: true,
    });
  } catch (err: any) {
    console.error(`[createForcaSubscriptionTokenPurchase] order=${orderId} charge threw:`, err);
    chargeResult = { success: false, ccode: -1 };
  }

  if (!chargeResult.success) {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `FORCASUBORDER#${orderId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :failed, hypCCode = :ccode, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed', ':ccode': chargeResult.ccode, ':now': new Date().toISOString() },
    }));
    return json(402, { success: false, error: 'charge_failed', ccode: chargeResult.ccode });
  }

  const { billingAgreementId } = await applyForcaSubscriptionCharge(
    order,
    orderId,
    chargeResult.transactionId ?? '',
    chargeResult.ccode,
    { token: savedToken, expiryMonth: savedExpiryMonth, expiryYear: savedExpiryYear },
    { cacheOnPayerProfile: false },
  );

  console.log(`[createForcaSubscriptionTokenPurchase] order=${orderId} user=${childUid} completed agreement=${billingAgreementId ?? 'none'}`);
  return json(200, { success: true, orderId, amountCharged: product.price });
}
