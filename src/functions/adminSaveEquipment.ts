import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { EquipmentItem } from '../lib/entities';

// POST /adminSaveEquipment
// Body: { id?: string, name: string, quantity: number, outCount?: number }
// Omit id to create (outCount defaults to 0 — nothing checked out yet).
// Pass id to rename/change quantity, or just to move outCount (e.g. the
// coach returns 2 of 3 ropes taken out — outCount goes from 3 to 1).
// Auth: Cognito JWT, caller must be admin. FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; quantity?: unknown; outCount?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const quantity = typeof body.quantity === 'number' && body.quantity >= 0 ? Math.floor(body.quantity) : 0;
  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  // A PutCommand replaces the whole item, so a rename/quantity-change has to
  // carry the original createdAt/createdBy (and outCount, if not explicitly
  // passed) forward explicitly rather than omitting them and hoping they survive.
  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  let outCount = 0;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EQUIPMENT#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as EquipmentItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
      outCount = existing.outCount ?? 0;
    }
  }
  if (typeof body.outCount === 'number') outCount = Math.floor(body.outCount);
  // Never let outCount drift outside [0, quantity] — a quantity decrease
  // (e.g. an item was lost/removed) clamps it back down too.
  outCount = Math.max(0, Math.min(outCount, quantity));

  const item: EquipmentItem = {
    PK: `EQUIPMENT#${id}`,
    SK: 'METADATA',
    name,
    quantity,
    outCount,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, name, quantity, outCount });
}
