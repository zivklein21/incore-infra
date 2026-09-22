import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMeasurableSessionWorkout } from '../lib/sessionWorkout';
import type { ExerciseDefinitionItem, ExerciseLogEntryItem } from '../lib/entities';

// POST /logSessionExercise
// Body: { classId: string, exerciseId: string, value: { weight?, reps?, timeSeconds?, bandLevel? }, loggedAt?: string }
// Auth: Cognito JWT, any signed-in FORCA member — always writes for herself.
// Only the trainee herself may log her own working weight (by explicit
// product decision — a coach's Post-Workout Report only ever gets a
// read-only view of who has/hasn't logged yet, see
// WorkoutLogGradingPanel.tsx; contrast with test grading, which the coach
// DOES enter directly). Writes the same ExerciseLogEntryItem shape as
// logExercise.ts (so getMyExerciseHistory.ts's "my Tracker history" stays
// one unified list either way), but only accepts a (classId, exerciseId)
// pair that resolveMeasurableSessionWorkout() would actually resolve — a
// session she was marked actually present for, whose assigned Workout Plan
// has a `measurable` section containing that exact exercise — and
// additionally stamps classId/workoutPlanId/stationId so
// getSessionWorkoutPlan.ts/sessionWorkoutLogStatus.ts can show "already
// logged" per station. Each save is a new history entry (append-only, same
// convention as logExercise.ts), not an overwrite of a prior log for that
// station.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { classId?: unknown; exerciseId?: unknown; value?: unknown; loggedAt?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });
  const exerciseId = typeof body.exerciseId === 'string' ? body.exerciseId.trim() : '';
  if (!exerciseId) return json(400, { error: 'missing_exercise_id' });

  const resolved = await resolveMeasurableSessionWorkout(callerUid, classId);
  if (!resolved.ok) return json(resolved.status, { error: resolved.error });

  let stationId: string | undefined;
  for (const section of resolved.measurableSections) {
    const station = (section.stations ?? []).find((st) => st.exerciseIds.includes(exerciseId));
    if (station) { stationId = station.id; break; }
  }
  if (!stationId) return json(403, { error: 'exercise_not_measurable_for_session' });

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

  const hasRequiredField =
    (exercise.measurementType === 'weight_reps' && value.weight != null && value.reps != null) ||
    (exercise.measurementType === 'reps_only' && value.reps != null) ||
    (exercise.measurementType === 'time' && value.timeSeconds != null) ||
    (exercise.measurementType === 'band_level' && !!value.bandLevel) ||
    (exercise.measurementType === 'bodyweight_reps' && value.reps != null) ||
    (exercise.measurementType === 'reps_band_level' && value.reps != null && !!value.bandLevel);
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
    classId,
    workoutPlanId: resolved.planId,
    stationId,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
