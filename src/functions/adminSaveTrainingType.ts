import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { TrainingTypeEquipmentRequirement, TrainingTypeItem } from '../lib/entities';

function parseEquipmentRequirements(raw: unknown): TrainingTypeEquipmentRequirement[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TrainingTypeEquipmentRequirement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const equipmentId = typeof (entry as any).equipmentId === 'string' ? (entry as any).equipmentId : '';
    const mode = (entry as any).mode === 'per_member' ? 'per_member' : (entry as any).mode === 'custom' ? 'custom' : '';
    if (!equipmentId || !mode) continue;
    const customQuantity = typeof (entry as any).customQuantity === 'number' ? (entry as any).customQuantity : undefined;
    out.push({ equipmentId, mode, ...(mode === 'custom' && customQuantity != null ? { customQuantity } : {}) });
  }
  return out;
}

// POST /adminSaveTrainingType
// Body: { id?: string, name: string, durationMinutes?: number,
//         equipmentRequirements?: { equipmentId, mode: 'custom'|'per_member', customQuantity? }[] }
// Omit id to create, pass it to rename/update.
// Auth: Cognito JWT, caller must be admin
// FORCA-only — see adminSaveClassType.ts for the INCORE equivalent.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; durationMinutes?: unknown; equipmentRequirements?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();
  const equipmentRequirements = parseEquipmentRequirements(body.equipmentRequirements);

  // A PutCommand replaces the whole item, so a rename has to carry the
  // original createdAt/createdBy forward explicitly rather than omitting
  // them and hoping they survive.
  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as TrainingTypeItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: TrainingTypeItem = {
    PK: `TRAININGTYPE#${id}`,
    SK: 'METADATA',
    name,
    ...(typeof body.durationMinutes === 'number' ? { durationMinutes: body.durationMinutes } : {}),
    ...(equipmentRequirements ? { equipmentRequirements } : {}),
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, name });
}
