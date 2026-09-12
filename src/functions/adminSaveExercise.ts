import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ExerciseDefinitionItem, ExerciseMeasurementType } from '../lib/entities';

const MEASUREMENT_TYPES: ExerciseMeasurementType[] = ['weight_reps', 'reps_only', 'time', 'band_level', 'bodyweight_reps'];

// POST /adminSaveExercise
// Body: { id?: string, name: string, measurementType: ExerciseMeasurementType,
//         bandLevels?: string[], active?: boolean } — omit id to create
// Auth: Cognito JWT, caller must be admin
// FORCA-only — mirrors adminSaveTrainingType.ts's create-or-update shape.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; measurementType?: unknown; bandLevels?: unknown; active?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const measurementType = MEASUREMENT_TYPES.includes(body.measurementType as ExerciseMeasurementType)
    ? body.measurementType as ExerciseMeasurementType : null;
  if (!measurementType) return json(400, { error: 'invalid_measurement_type' });

  const bandLevels = measurementType === 'band_level' && Array.isArray(body.bandLevels)
    ? body.bandLevels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).map((l) => l.trim())
    : undefined;
  if (measurementType === 'band_level' && (!bandLevels || bandLevels.length === 0)) {
    return json(400, { error: 'missing_band_levels' });
  }

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
    measurementType,
    ...(bandLevels ? { bandLevels } : {}),
    active: body.active === true,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
