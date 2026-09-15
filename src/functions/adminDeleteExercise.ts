import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';

// POST /adminDeleteExercise
// Body: { id: string }
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write' — see
// adminSaveExercise.ts.
// Hard delete — past ExerciseLogEntryItems are untouched (historical
// record; denormalized name/measurementType keep them meaningful). Any
// WorkoutPlanBlockItem (section) still listing this exercise's id in its
// exerciseIds is also left untouched — adminListWorkoutPlans.ts's name
// resolution just drops an id it can no longer find, same "leave stale
// refs alone" convention as adminDeleteWorkoutPlan.ts's ClassItem refs.
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

  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${id}`, SK: 'METADATA' } }));

  return json(200, { success: true });
}
