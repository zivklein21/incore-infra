import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getMemberFirstLastName, getMemberFullName, getMemberIdNumber, buildHypInfo, HYP_NO_ID_PLACEHOLDER } from '../lib/hypOrders';
import { createHypSignedPaymentUrl, HypSignError } from '../lib/hypClient';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ForcaSubscriptionOrderItem, ForcaSubscriptionProductItem, GroupItem, MemberProfileItem } from '../lib/entities';

// POST /createForcaSubscriptionPaymentPage
// Auth: Cognito JWT (any signed-in FORCA member)
// Body: { subscriptionProductId: string, childUid: string }
// Response: { paymentUrl: string, orderId: string }
//
// Subscriptions are purchasable ONLY through a parent account for a linked
// trainee — see the FORCA billing spec's "Parent-Only Subscription
// Purchasing" requirement. Unlike createMerchPaymentPage.ts, childUid is
// REQUIRED here, never optional self-checkout. Family-link authorized
// (verifyFamilyLink), and the HYP charge is always billed to the PARENT's
// own profile (ClientName/email/cell/UserId), never the trainee's — same
// convention as createMerchPaymentPage.ts, see its own comment.
//
// This is a one-time (tash=1) charge for the first month only. The card
// token this purchase captures is saved by
// lib/forcaSubscriptionPayments.ts's handleForcaSubscriptionOrderCallback()
// once HYP confirms the charge, which is also where the recurring
// ForcaBillingAgreementItem gets created for every following month.
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

  const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${product.groupId}`, SK: 'METADATA' } }));
  const group = groupRes.Item as GroupItem | undefined;
  if (!group) return json(404, { error: 'group_not_found' });

  const { firstName: clientFirstName, lastName: clientLastName } = getMemberFirstLastName(payer);
  const email = payer.identity?.email || payer.email || '';
  const cell = payer.identity?.phone || payer.phone || '';
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

  try {
    const paymentUrl = await createHypSignedPaymentUrl({
      order: orderId,
      amount: product.price,
      tash: 1,
      clientName: clientFirstName,
      clientLName: clientLastName || undefined,
      email: email || undefined,
      cell: cell || undefined,
      userId: getMemberIdNumber(payer) || HYP_NO_ID_PLACEHOLDER,
      info: buildHypInfo(product.name, `שם הילדה: ${childName}`),
      pageLang: 'HEB',
      sendReceipt: true,
    });
    return json(200, { paymentUrl, orderId, amountCharged: product.price });
  } catch (err: any) {
    console.error('[createForcaSubscriptionPaymentPage] HYP SIGN call failed:', err);
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `FORCASUBORDER#${orderId}`, SK: 'METADATA' },
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
