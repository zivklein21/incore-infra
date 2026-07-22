import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ProductItem } from '../lib/entities';
import { grantPunchCardToMember } from '../lib/punchCards';

// POST /grantPunchCard
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; productId?: unknown; expiresInDays?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
  const expiresInDays = typeof body.expiresInDays === 'number' ? body.expiresInDays : null;
  if (!memberId || !productId) return json(400, { error: 'missing_fields', required: ['memberId', 'productId'] });

  const [memberRes, productRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } })),
  ]);
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });
  const product = productRes.Item as ProductItem | undefined;
  if (!product) return json(404, { error: 'product_not_found' });
  if (!product.active) return json(400, { error: 'product_inactive' });

  const sessions = product.sessions ?? 1;
  const cardType: 'mid_month' | 'extra_class' = product.type === 'mid_month' ? 'mid_month' : 'extra_class';

  let expiresAt: Date | null = null;
  if (expiresInDays !== null && expiresInDays > 0) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);
    expiresAt.setHours(23, 59, 59, 999);
  }

  const cardId = await grantPunchCardToMember({
    memberId,
    productId,
    productName: product.name ?? '',
    sessions,
    cardType,
    expiresAt,
    source: 'admin_grant',
  });

  console.log(`[grantPunchCard] admin=${adminUid} member=${memberId} product=${productId} sessions=${sessions} card=${cardId}`);
  return json(200, { success: true, punchCardId: cardId, sessions });
}
