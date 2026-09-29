import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';

// POST /adminDeleteMeasurementType
// Body: { id: string }
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write' — see
// adminSaveMeasurementType.ts. Does not touch any ExerciseDefinitionItem
// that already references this id via measurementTypeId — its own
// measurementType (the real behavioral shape) is untouched either way; the
// client falls back to that built-in type's own label once the custom
// entry is gone, same "delete the catalog entry, existing records keep
// working" convention as WorkoutPackageTypeItem/WorkoutMethodTypeItem.
// FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  let body: { id?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });

  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEASUREMENTTYPE#${id}`, SK: 'METADATA' } }));
  return json(200, { success: true });
}
