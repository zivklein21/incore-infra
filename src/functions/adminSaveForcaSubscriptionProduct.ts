import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ForcaSubscriptionProductItem } from '../lib/entities';

// POST /adminSaveForcaSubscriptionProduct
// Body: { id?: string, name: string, description?: string, price: number,
//         groupId: string, visibility: 'PUBLIC' | 'PRIVATE',
//         targetParentUids?: string[], active?: boolean } — omit id to create
// Auth: Cognito JWT, caller must be admin
// FORCA-only. See entities.ts's ForcaSubscriptionProductItem.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; name?: unknown; description?: unknown; price?: unknown;
    groupId?: unknown; visibility?: unknown; targetParentUids?: unknown; active?: unknown;
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
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  if (!groupId) return json(400, { error: 'missing_group' });
  const visibility = body.visibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC';
  const targetParentUids = visibility === 'PRIVATE' && Array.isArray(body.targetParentUids)
    ? body.targetParentUids.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    : [];
  if (visibility === 'PRIVATE' && targetParentUids.length === 0) return json(400, { error: 'missing_target_parents' });

  const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } }));
  if (!groupRes.Item) return json(404, { error: 'group_not_found' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCASUBPRODUCT#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as ForcaSubscriptionProductItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: ForcaSubscriptionProductItem = {
    PK: `FORCASUBPRODUCT#${id}`,
    SK: 'METADATA',
    name,
    ...(typeof body.description === 'string' && body.description.trim() ? { description: body.description.trim() } : {}),
    price,
    groupId,
    visibility,
    ...(visibility === 'PRIVATE' ? { targetParentUids } : {}),
    active: body.active === true,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
