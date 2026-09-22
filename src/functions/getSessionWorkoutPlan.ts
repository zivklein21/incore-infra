import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMeasurableSessionWorkout } from '../lib/sessionWorkout';
import type { ExerciseDefinitionItem, ExerciseLogEntryItem } from '../lib/entities';

// GET or POST /getSessionWorkoutPlan
// Query/body: { classId: string }
// Auth: Cognito JWT, any signed-in FORCA member — but only for a session she
// actually attended (see resolveMeasurableSessionWorkout()), and only the
// `measurable` sections of its assigned Workout Plan; an unmeasured warm-up
// or the mandatory closing section never appears here. Powers the trainee's
// "log this session's workout" screen — logSessionExercise.ts is the write
// side, sharing the same resolver so a caller can never log against
// something this endpoint wouldn't have shown her. Each station's own
// already-logged result (if any) for this exact session is joined in via
// the caller's own GSI1 exercise-log history, so the screen can show
// "already logged" per station on a repeat visit.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let classId = event.queryStringParameters?.classId ?? '';
  if (!classId && event.body) {
    try {
      const body = JSON.parse(event.body) as { classId?: unknown };
      classId = typeof body.classId === 'string' ? body.classId : '';
    } catch { /* ignore */ }
  }
  if (!classId) return json(400, { error: 'missing_class_id' });

  const resolved = await resolveMeasurableSessionWorkout(uid, classId);
  if (!resolved.ok) return json(resolved.status, { error: resolved.error });
  const { session, planId, planName, measurableSections } = resolved;

  const exerciseIds = [...new Set(measurableSections.flatMap((b) => (b.stations ?? []).flatMap((st) => st.exerciseIds)))];
  const exercisesById = new Map<string, ExerciseDefinitionItem>();
  await Promise.all(exerciseIds.map(async (exId) => {
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${exId}`, SK: 'METADATA' } }));
    if (res.Item) exercisesById.set(exId, res.Item as ExerciseDefinitionItem);
  }));

  const logsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'EXERCISELOG#' },
  }));
  const loggedByStationId = new Map<string, ExerciseLogEntryItem>();
  for (const entry of (logsRes.Items ?? []) as ExerciseLogEntryItem[]) {
    if (entry.classId !== classId || !entry.stationId) continue;
    const existing = loggedByStationId.get(entry.stationId);
    if (!existing || entry.loggedAt > existing.loggedAt) loggedByStationId.set(entry.stationId, entry);
  }

  const sections = measurableSections.map((b) => ({
    id: b.SK.replace('BLOCK#', ''),
    label: b.label,
    stations: (b.stations ?? []).slice().sort((a, c) => a.order - c.order).map((st) => {
      const logged = loggedByStationId.get(st.id);
      return {
        id: st.id,
        name: st.name ?? '',
        notes: st.notes ?? '',
        exercises: st.exerciseIds.map((exId, i) => ({
          id: exId,
          name: st.exerciseNames[i] ?? exercisesById.get(exId)?.name ?? '',
          measurementType: exercisesById.get(exId)?.measurementType ?? 'reps_only',
          bandLevels: exercisesById.get(exId)?.bandLevels ?? [],
        })),
        logged: logged
          ? { exerciseId: logged.exerciseId, exerciseName: logged.exerciseName, value: logged.value, loggedAt: logged.loggedAt }
          : null,
      };
    }),
  }));

  return json(200, {
    classId,
    className: session.className ?? '',
    date: session.date,
    workoutPlanId: planId,
    workoutPlanName: planName,
    sections,
  });
}
