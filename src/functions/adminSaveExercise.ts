import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import { decomposeMeasurementType, type ExerciseDefinitionItem, type ExerciseEquipmentRequirement, type ExerciseMeasurementType, type MeasurementTypeItem } from '../lib/entities';

// A raw (non-measurementTypeId) direct assignment still only offers the
// original 6 flag-composed shapes plus the 2 legacy ones — the wider mixes
// unlocked by MeasurementTypesModal's checkboxes are reachable only through
// a custom measurementTypeId, never picked bare (see
// ExercisesManageScreen.tsx's own built-in quick-pick pills, deliberately
// left at these 8 same as before).
const MEASUREMENT_TYPES: ExerciseMeasurementType[] = ['weight_reps', 'reps_only', 'time', 'band_level', 'bodyweight_reps', 'reps_band_level', 'weight', 'weight_time'];

interface EquipmentInput { equipmentId?: unknown; quantity?: unknown }

function resolveEquipment(raw: unknown): ExerciseEquipmentRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: ExerciseEquipmentRequirement[] = [];
  for (const entry of raw as EquipmentInput[]) {
    const equipmentId = typeof entry?.equipmentId === 'string' ? entry.equipmentId.trim() : '';
    if (!equipmentId) continue;
    const quantity = typeof entry?.quantity === 'number' && Number.isFinite(entry.quantity) && entry.quantity > 0
      ? Math.floor(entry.quantity) : 1;
    out.push({ equipmentId, quantity });
  }
  return out;
}

// POST /adminSaveExercise
// Body: { id?: string, name: string, category?: string, measurementType: ExerciseMeasurementType,
//         measurementTypeId?: string, bandLevels?: string[], equipment?: { equipmentId: string, quantity?: number }[],
//         active?: boolean } — omit id to create; quantity defaults to 1.
// measurementTypeId (optional) points at an admin-managed custom-named
// measurement type (see entities.ts's MeasurementTypeItem) — when given, its
// own baseType OVERRIDES whatever measurementType the client sent, so the
// two can never disagree; measurementType stays required for a plain
// built-in type (no measurementTypeId).
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write' — exercises
// are the building blocks of workout plans, so the same permission governs
// both catalogs (see WorkoutPlansManageScreen.tsx).
// FORCA-only — mirrors adminSaveTrainingType.ts's create-or-update shape.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; category?: unknown; measurementType?: unknown; measurementTypeId?: unknown; bandLevels?: unknown; equipment?: unknown; active?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : undefined;

  const measurementTypeId = typeof body.measurementTypeId === 'string' && body.measurementTypeId ? body.measurementTypeId : undefined;
  let measurementType: ExerciseMeasurementType | null = MEASUREMENT_TYPES.includes(body.measurementType as ExerciseMeasurementType)
    ? body.measurementType as ExerciseMeasurementType : null;
  if (measurementTypeId) {
    const customRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEASUREMENTTYPE#${measurementTypeId}`, SK: 'METADATA' } }));
    const custom = customRes.Item as MeasurementTypeItem | undefined;
    if (!custom) return json(404, { error: 'measurement_type_not_found' });
    measurementType = custom.baseType; // overrides whatever the client sent — see doc comment above
  }
  if (!measurementType) return json(400, { error: 'invalid_measurement_type' });

  const needsBandLevels = decomposeMeasurementType(measurementType).bandLevel;
  const bandLevels = needsBandLevels && Array.isArray(body.bandLevels)
    ? body.bandLevels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).map((l) => l.trim())
    : undefined;
  if (needsBandLevels && (!bandLevels || bandLevels.length === 0)) {
    return json(400, { error: 'missing_band_levels' });
  }
  const equipment = resolveEquipment(body.equipment);

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as ExerciseDefinitionItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: ExerciseDefinitionItem = {
    PK: `EXERCISE#${id}`,
    SK: 'METADATA',
    name,
    ...(category ? { category } : {}),
    measurementType,
    ...(measurementTypeId ? { measurementTypeId } : {}),
    ...(bandLevels ? { bandLevels } : {}),
    ...(equipment.length > 0 ? { equipment } : {}),
    active: body.active === true,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
