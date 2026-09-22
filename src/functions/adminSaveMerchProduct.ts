import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MerchProductItem, MerchVariant } from '../lib/entities';

// POST /adminSaveMerchProduct
// Body: { id?: string, name: string, description?: string, price: number,
//         imageKeys?: string[], variants?: {id?: string, label: string, stock: number}[],
//         active?: boolean } — omit id to create
// Auth: Cognito JWT, caller must be admin
// FORCA-only. variants is replaced wholesale on every save (same convention
// as TrainingTypeItem.equipmentRequirements) — a variant missing an id gets
// one minted here, so the admin form can freely add new rows without
// generating ids client-side.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; name?: unknown; description?: unknown; price?: unknown;
    imageKeys?: unknown; variants?: unknown; active?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const price = typeof body.price === 'number' && body.price >= 0 ? body.price : NaN;
  if (!Number.isFinite(price)) return json(400, { error: 'invalid_price' });

  const imageKeys = Array.isArray(body.imageKeys)
    ? body.imageKeys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    : [];

  const rawVariants = Array.isArray(body.variants) ? body.variants : [];
  const variants: MerchVariant[] = rawVariants.map((v) => {
    const r = v && typeof v === 'object' ? v as Record<string, unknown> : {};
    return {
      id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
      label: typeof r.label === 'string' ? r.label.trim() : '',
      stock: typeof r.stock === 'number' && r.stock >= 0 ? Math.trunc(r.stock) : 0,
    };
  }).filter((v) => v.label.length > 0);
  if (variants.length === 0) return json(400, { error: 'missing_variants' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MERCHPRODUCT#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as MerchProductItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: MerchProductItem = {
    PK: `MERCHPRODUCT#${id}`,
    SK: 'METADATA',
    name,
    ...(typeof body.description === 'string' && body.description.trim() ? { description: body.description.trim() } : {}),
    price,
    imageKeys,
    variants,
    active: body.active === true,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
