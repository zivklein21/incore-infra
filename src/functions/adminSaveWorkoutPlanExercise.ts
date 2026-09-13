import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ExerciseDefinitionItem, WorkoutPlanExerciseItem } from '../lib/entities';

// POST /adminSaveWorkoutPlanExercise
// Body: { id?: string, planId: string, exerciseId: string, sets?: number,
//         reps?: string, restSeconds?: number, notes?: string, order?: number }
//   — omit id to create; omit order on create to append at the end of the
//   plan's current list; pass order explicitly to reorder (the builder
//   screen swaps two rows' order with two calls — see
//   WorkoutPlansManageScreen.tsx)
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; planId?: unknown; exerciseId?: unknown; sets?: unknown;
    reps?: unknown; restSeconds?: unknown; notes?: unknown; order?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
  if (!planId) return json(400, { error: 'missing_plan_id' });
  const exerciseId = typeof body.exerciseId === 'string' ? body.exerciseId.trim() : '';
  if (!exerciseId) return json(400, { error: 'missing_exercise_id' });
  const sets = typeof body.sets === 'number' && Number.isFinite(body.sets) ? body.sets : undefined;
  const reps = typeof body.reps === 'string' && body.reps.trim() ? body.reps.trim() : undefined;
  const restSeconds = typeof body.restSeconds === 'number' && Number.isFinite(body.restSeconds) ? body.restSeconds : undefined;
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : undefined;

  const planRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${planId}`, SK: 'METADATA' } }));
  if (!planRes.Item) return json(404, { error: 'workout_plan_not_found' });

  const exerciseRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${exerciseId}`, SK: 'METADATA' } }));
  const exerciseDef = exerciseRes.Item as ExerciseDefinitionItem | undefined;
  if (!exerciseDef) return json(404, { error: 'exercise_not_found' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let order = typeof body.order === 'number' && Number.isFinite(body.order) ? body.order : null;

  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${planId}`, SK: `EXERCISE#${existingId}` } }));
    const existing = existingRes.Item as WorkoutPlanExerciseItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      if (order === null) order = existing.order;
    }
  }

  if (order === null) {
    // Append at the end — one Query for the current count rather than
    // trusting the frontend's own list length.
    const currentRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${planId}`, ':prefix': 'EXERCISE#' },
    }));
    order = (currentRes.Items ?? []).length;
  }

  const item: WorkoutPlanExerciseItem = {
    PK: `WORKOUTPLAN#${planId}`,
    SK: `EXERCISE#${id}`,
    planId,
    exerciseId,
    exerciseName: exerciseDef.name,
    order,
    ...(sets !== undefined ? { sets } : {}),
    ...(reps !== undefined ? { reps } : {}),
    ...(restSeconds !== undefined ? { restSeconds } : {}),
    ...(notes !== undefined ? { notes } : {}),
    createdAt,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
