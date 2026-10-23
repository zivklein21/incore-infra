import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getMemberFullName, getMemberIdNumber, buildHypInfo, HYP_NO_ID_PLACEHOLDER } from '../lib/hypOrders';
import { chargeHypToken } from '../lib/hypClient';
import { verifyFamilyLink } from '../lib/familyLinks';
import { applyMerchOrderCharge } from '../lib/merchPayments';
import type { MemberProfileItem, MerchOrderItem, MerchOrderLineItem, MerchProductItem } from '../lib/entities';

// POST /createForcaMerchTokenPurchase
// Auth: Cognito JWT (any signed-in FORCA member)
// Body: { items: { merchProductId: string, merchVariantId: string, quantity: number }[], childUid?: string }
// Response: { success: true, orderId, amountCharged } | 402 { success: false, error: 'charge_failed', ccode }
//
// The saved-card counterpart to createMerchPaymentPage.ts — identical
// validation/order-building, but charges the billed member's already-saved
// HYP token directly (see createHypTokenPurchase.ts, INCORE's equivalent)
// instead of opening a hosted page. Note: FORCA merch purchases themselves
// never tokenize a card (see createMerchPaymentPage.ts's own comment) — the
// only way a FORCA parent has a saved token at all today is from a prior
// subscription purchase. That token is billedMember.payment.hypToken
// regardless of what it was originally captured for.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { items?: unknown; childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (childUid) {
    const link = await verifyFamilyLink(callerUid, childUid);
    if (!link.ok) return json(403, { error: 'forbidden' });
  }
  const uid = childUid || callerUid;

  const rawItems = Array.isArray(body.items) ? body.items : [];
  const requested = rawItems
    .map((r) => {
      const o = r && typeof r === 'object' ? r as Record<string, unknown> : {};
      return {
        merchProductId: typeof o.merchProductId === 'string' ? o.merchProductId.trim() : '',
        merchVariantId: typeof o.merchVariantId === 'string' ? o.merchVariantId.trim() : '',
        quantity: typeof o.quantity === 'number' && o.quantity > 0 ? Math.trunc(o.quantity) : 0,
      };
    })
    .filter((r) => r.merchProductId && r.merchVariantId && r.quantity > 0);
  if (requested.length === 0) return json(400, { error: 'missing_items' });

  const memberRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  const member = memberRes.Item as MemberProfileItem | undefined;
  if (!member) return json(404, { error: 'member_not_found' });

  let payer: MemberProfileItem | undefined;
  if (childUid) {
    const payerRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' } }));
    payer = payerRes.Item as MemberProfileItem | undefined;
    if (!payer) return json(404, { error: 'payer_not_found' });
  }

  const billedMember = payer ?? member;
  const savedToken = billedMember.payment?.hypToken;
  const savedExpiryMonth = billedMember.payment?.hypTokenExpiryMonth;
  const savedExpiryYear = billedMember.payment?.hypTokenExpiryYear;
  if (!savedToken || !savedExpiryMonth || !savedExpiryYear) return json(400, { error: 'no_saved_token' });

  const productIds = Array.from(new Set(requested.map((r) => r.merchProductId)));
  const productResults = await Promise.all(productIds.map((id) =>
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MERCHPRODUCT#${id}`, SK: 'METADATA' } })),
  ));
  const productsById = new Map<string, MerchProductItem>();
  productResults.forEach((res, i) => {
    if (res.Item) productsById.set(productIds[i], res.Item as MerchProductItem);
  });

  const lineItems: MerchOrderLineItem[] = [];
  for (const r of requested) {
    const product = productsById.get(r.merchProductId);
    if (!product) return json(404, { error: 'product_not_found' });
    if (!product.active) return json(400, { error: 'product_inactive' });
    const variant = product.variants.find((v) => v.id === r.merchVariantId);
    if (!variant) return json(404, { error: 'variant_not_found' });
    if (variant.stock < r.quantity) return json(400, { error: 'out_of_stock' });
    if (!(product.price >= 0)) return json(400, { error: 'invalid_price' });

    lineItems.push({
      merchProductId: product.PK.replace('MERCHPRODUCT#', ''),
      merchProductName: product.name,
      merchVariantId: variant.id,
      merchVariantLabel: variant.label,
      quantity: r.quantity,
      unitPrice: product.price,
    });
  }

  const totalAmount = lineItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  if (totalAmount <= 0) return json(400, { error: 'invalid_price' });

  const childName = childUid ? getMemberFullName(member) : undefined;

  const orderId = `merch-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const order: MerchOrderItem = {
    PK: `MERCHORDER#${orderId}`,
    SK: 'METADATA',
    GSI1PK: `MEMBER#${uid}`,
    GSI1SK: `MERCHORDER#${nowIso}#${orderId}`,
    GSI2PK: 'MERCHORDER',
    GSI2SK: `${nowIso}#${orderId}`,
    orderId,
    userId: uid,
    status: 'pending',
    items: lineItems,
    amount: totalAmount,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(childUid ? {
      childUid,
      childName,
      payerUid: callerUid,
      payerName: getMemberFullName(payer!),
    } : {}),
  };
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: order }));

  const infoLine = lineItems.map((item) => `${item.merchProductName} (${item.merchVariantLabel})${item.quantity > 1 ? ` x${item.quantity}` : ''}`).join(', ');

  let chargeResult;
  try {
    chargeResult = await chargeHypToken({
      token: savedToken,
      expiryMonth: savedExpiryMonth,
      expiryYear: savedExpiryYear,
      amount: totalAmount,
      userId: getMemberIdNumber(billedMember) || HYP_NO_ID_PLACEHOLDER,
      clientName: getMemberFullName(billedMember),
      info: childName ? buildHypInfo(infoLine, `שם הילדה: ${childName}`) : buildHypInfo(infoLine),
      email: billedMember.identity?.email || billedMember.email || undefined,
      sendReceipt: true,
    });
  } catch (err: any) {
    console.error(`[createForcaMerchTokenPurchase] order=${orderId} charge threw:`, err);
    chargeResult = { success: false, ccode: -1 };
  }

  if (!chargeResult.success) {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MERCHORDER#${orderId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :failed, hypCCode = :ccode, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed', ':ccode': chargeResult.ccode, ':now': new Date().toISOString() },
    }));
    return json(402, { success: false, error: 'charge_failed', ccode: chargeResult.ccode });
  }

  await applyMerchOrderCharge(order, orderId, chargeResult.transactionId ?? '', chargeResult.ccode);

  console.log(`[createForcaMerchTokenPurchase] order=${orderId} user=${uid} completed`);
  return json(200, { success: true, orderId, amountCharged: totalAmount });
}
