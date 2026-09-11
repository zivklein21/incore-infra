import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getMemberFirstLastName, getMemberIdNumber, buildHypInfo, HYP_NO_ID_PLACEHOLDER } from '../lib/hypOrders';
import { createHypSignedPaymentUrl, HypSignError } from '../lib/hypClient';
import type { MemberProfileItem, MerchOrderItem, MerchOrderLineItem, MerchProductItem } from '../lib/entities';

// POST /createMerchPaymentPage
// Auth: Cognito JWT (any signed-in FORCA member)
// Body: { items: { merchProductId: string, merchVariantId: string, quantity: number }[] }
// Response: { paymentUrl: string, orderId: string }
//
// One or more line items — "Buy Now" sends a single-entry list (quantity 1),
// a cart checkout sends the whole cart; both are the same order shape (see
// entities.ts's MerchOrderItem) and the same endpoint, not two code paths.
//
// Deliberately separate from createHypPaymentPage.ts/buildOrderFromProduct
// (which is wired to ProductItem's subscription/installment/mid-month
// shape, none of which applies here) — see entities.ts's MerchOrderItem
// comment for the full reasoning. Reuses the same underlying HYP
// account/client (createHypSignedPaymentUrl) since both brands share one
// HYP merchant account; only the order bookkeeping is kept separate.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { items?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

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

  // Distinct products only — dedupe before the lookup round-trip below (a
  // cart can have multiple lines for different variants of the same product).
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

  const { firstName: clientFirstName, lastName: clientLastName } = getMemberFirstLastName(member);
  const email = member.identity?.email || member.email || '';
  const cell = member.identity?.phone || member.phone || '';

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
  };
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: order }));

  const infoLine = lineItems.map((item) => `${item.merchProductName} (${item.merchVariantLabel})${item.quantity > 1 ? ` x${item.quantity}` : ''}`).join(', ');

  try {
    const paymentUrl = await createHypSignedPaymentUrl({
      order: orderId,
      amount: totalAmount,
      tash: 1,
      clientName: clientFirstName,
      clientLName: clientLastName || undefined,
      email: email || undefined,
      cell: cell || undefined,
      userId: getMemberIdNumber(member) || HYP_NO_ID_PLACEHOLDER,
      info: buildHypInfo(infoLine),
      pageLang: 'HEB',
      sendReceipt: true,
    });
    return json(200, { paymentUrl, orderId, amountCharged: totalAmount });
  } catch (err: any) {
    console.error('[createMerchPaymentPage] HYP SIGN call failed:', err);
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MERCHORDER#${orderId}`, SK: 'METADATA' },
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
