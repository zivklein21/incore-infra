import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminSaveProduct
// Body: { id?: string, brand?: 'incore' | 'forca', ...ProductItem fields } — omit id to create
// Auth: Cognito JWT, caller must be admin
//
// brand comes from the admin's Backoffice toggle (AdminBrandModeContext),
// same permissive pattern as adminCreateUser.ts — anything but the literal
// 'forca' defaults to 'incore'. Picks which table this plan is written to;
// see the FORCA data separation plan.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const isNew = !(typeof body.id === 'string' && body.id);

  const item: Record<string, unknown> = {
    PK: `PRODUCT#${id}`,
    SK: 'METADATA',
    name,
    description: typeof body.description === 'string' ? body.description : '',
    price: typeof body.price === 'number' ? body.price : 0,
    sessions: typeof body.sessions === 'number' ? body.sessions : 0,
    active: body.active !== false,
    is_public: body.is_public !== false,
  };
  if (typeof body.type === 'string') item.type = body.type;
  if (typeof body.sessions_per_week === 'number') item.sessions_per_week = body.sessions_per_week;
  if (Array.isArray(body.assigned_to)) item.assigned_to = body.assigned_to;
  if (typeof body.visibility === 'string') item.visibility = body.visibility;
  if (Array.isArray(body.target_group_ids)) item.target_group_ids = body.target_group_ids;
  if (typeof body.productImageUrl === 'string') item.productImageUrl = body.productImageUrl;
  if (typeof body.monthlyLimit === 'number') item.monthlyLimit = body.monthlyLimit;
  if (typeof body.weeklyLimit === 'number') item.weeklyLimit = body.weeklyLimit;
  if (typeof body.allowedLegalCancellationsPerMonth === 'number') item.allowedLegalCancellationsPerMonth = body.allowedLegalCancellationsPerMonth;
  if (typeof body.endDate === 'string' || body.endDate === null) item.expires_at = body.endDate;
  if (typeof body.installments === 'number') item.installments = body.installments;
  if (typeof body.popular === 'boolean') item.popular = body.popular;
  if (typeof body.priority_book === 'boolean') item.priority_book = body.priority_book;
  if (Array.isArray(body.allowed_class_ids)) item.allowed_class_ids = body.allowed_class_ids;
  if (isNew) item.createdAt = new Date().toISOString();

  const brand = body.brand === 'forca' ? 'forca' as const : 'incore' as const;
  await ddb.send(new PutCommand({ TableName: tableForBrand(brand), Item: item }));

  return json(200, { success: true, id });
}
