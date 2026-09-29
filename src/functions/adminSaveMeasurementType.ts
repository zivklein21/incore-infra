import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import { ALL_MEASUREMENT_TYPES, type ExerciseMeasurementType, type MeasurementTypeItem } from '../lib/entities';

// POST /adminSaveMeasurementType
// Body: { id?: string, name: string, baseType: ExerciseMeasurementType } —
// omit id to create, pass id to rename/re-map. baseType picks which mix of
// the 4 underlying components (weight/bodyweight/reps/band level — see
// entities.ts's MeasurementFlags/composeMeasurementType, and
// ExercisesManageScreen.tsx's MeasurementTypesModal checkboxes on the
// client) this custom-named type actually behaves as, or one of the 2 fixed
// legacy shapes (time/weight_time) that stand outside that component
// system — changing it on an existing entry changes behavior for every
// exercise using it, same "the catalog defines what's offered" convention
// as WorkoutPackageTypeItem/WorkoutMethodTypeItem.
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write' — same tier
// as the Exercise Pool this feeds. FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; baseType?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const baseType = ALL_MEASUREMENT_TYPES.includes(body.baseType as ExerciseMeasurementType) ? body.baseType as ExerciseMeasurementType : null;
  if (!baseType) return json(400, { error: 'invalid_base_type' });
  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEASUREMENTTYPE#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as MeasurementTypeItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: MeasurementTypeItem = {
    PK: `MEASUREMENTTYPE#${id}`,
    SK: 'METADATA',
    name,
    baseType,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, name, baseType });
}
