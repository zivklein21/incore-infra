import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypBillingAgreementItem, ProductItem } from '../lib/entities';

// POST /adminChangeHypBillingAgreementPlan
// Auth: Cognito JWT, caller must be admin
// Body: { agreementId: string, newProductId: string }
// Switches a subscription agreement onto a different plan — current paid
// period untouched; only the amount charged on the next 1st-of-month
// charge changes.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { agreementId?: unknown; newProductId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const agreementId = typeof body.agreementId === 'string' ? body.agreementId.trim() : '';
  const newProductId = typeof body.newProductId === 'string' ? body.newProductId.trim() : '';
  if (!agreementId || !newProductId) return json(400, { error: 'missing_fields', required: ['agreementId', 'newProductId'] });

  const key = { PK: `AGREEMENT#${agreementId}`, SK: 'METADATA' };
  const agreementRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const agreement = agreementRes.Item as HypBillingAgreementItem | undefined;
  if (!agreement) return json(404, { error: 'agreement_not_found' });
  if (agreement.kind !== 'subscription') return json(400, { error: 'not_a_subscription' });

  const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${newProductId}`, SK: 'METADATA' } }));
  const product = productRes.Item as ProductItem | undefined;
  if (!product) return json(404, { error: 'product_not_found' });
  if (product.type !== 'subscription') return json(400, { error: 'product_not_a_subscription' });
  if (product.active === false) return json(400, { error: 'product_inactive' });

  const newAmount = product.price ?? 0;
  const newName = product.name ?? newProductId;

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET productId = :pid, productName = :pname, amountPerCharge = :amt, updatedAt = :now',
    ExpressionAttributeValues: { ':pid': newProductId, ':pname': newName, ':amt': newAmount, ':now': new Date().toISOString() },
  }));

  console.log(`[adminChangeHypBillingAgreementPlan] agreement=${agreementId} -> product=${newProductId} (₪${newAmount}) by ${callerUid}`);
  return json(200, { success: true, productId: newProductId, productName: newName, amountPerCharge: newAmount });
}
