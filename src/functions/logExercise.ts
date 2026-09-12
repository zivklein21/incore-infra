import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ExerciseDefinitionItem, ExerciseLogEntryItem } from '../lib/entities';

// POST /logExercise
// Body: { exerciseId: string, value: { weight?, reps?, timeSeconds?, bandLevel? }, loggedAt?: string }
// Auth: Cognito JWT, any signed-in FORCA member — always writes for herself
// (no memberId param; see getMemberExerciseHistory.ts for the admin's
// cross-member read path). loggedAt defaults to now; a trainee logging
// "after the workout" a little later same-day can still backdate it.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { exerciseId?: unknown; value?: unknown; loggedAt?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const exerciseId = typeof body.exerciseId === 'string' ? body.exerciseId.trim() : '';
  if (!exerciseId) return json(400, { error: 'missing_exercise_id' });

  const exerciseRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${exerciseId}`, SK: 'METADATA' } }));
  const exercise = exerciseRes.Item as ExerciseDefinitionItem | undefined;
  if (!exercise) return json(404, { error: 'exercise_not_found' });

  const raw = body.value && typeof body.value === 'object' ? body.value as Record<string, unknown> : {};
  const value: ExerciseLogEntryItem['value'] = {
    ...(typeof raw.weight === 'number' ? { weight: raw.weight } : {}),
    ...(typeof raw.reps === 'number' ? { reps: raw.reps } : {}),
    ...(typeof raw.timeSeconds === 'number' ? { timeSeconds: raw.timeSeconds } : {}),
    ...(typeof raw.bandLevel === 'string' && raw.bandLevel ? { bandLevel: raw.bandLevel } : {}),
  };

  // Require at least the field(s) this exercise's measurement type actually
  // needs — a "weight_reps" entry with neither weight nor reps set isn't a
  // real log, it's an empty submit.
  const hasRequiredField =
    (exercise.measurementType === 'weight_reps' && value.weight != null && value.reps != null) ||
    (exercise.measurementType === 'reps_only' && value.reps != null) ||
    (exercise.measurementType === 'time' && value.timeSeconds != null) ||
    (exercise.measurementType === 'band_level' && !!value.bandLevel) ||
    (exercise.measurementType === 'bodyweight_reps' && value.reps != null);
  if (!hasRequiredField) return json(400, { error: 'missing_value' });

  const id = randomUUID();
  const loggedAt = typeof body.loggedAt === 'string' && body.loggedAt ? body.loggedAt : new Date().toISOString();
  const nowIso = new Date().toISOString();

  const item: ExerciseLogEntryItem = {
    PK: `EXERCISELOG#${id}`,
    SK: 'METADATA',
    GSI1PK: `MEMBER#${callerUid}`,
    GSI1SK: `EXERCISELOG#${exerciseId}#${loggedAt}#${id}`,
    userId: callerUid,
    exerciseId,
    exerciseName: exercise.name,
    measurementType: exercise.measurementType,
    value,
    loggedAt,
    createdAt: nowIso,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
