import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ClassItem, RegistrationItem, WorkoutPlanBlockItem } from './entities';

export type ResolveSessionWorkoutResult =
  | {
      ok: true;
      session: ClassItem;
      planId: string;
      planName: string;
      /** Only 'stations' sections flagged measurable === true, sorted by order — a 'freeText' section or the mandatory locked closing section never appears here. */
      measurableSections: (WorkoutPlanBlockItem & { PK: string; SK: string })[];
    }
  | { ok: false; status: number; error: string };

// Shared by getSessionWorkoutPlan.ts (read) and logSessionExercise.ts
// (write) so a caller can never log against a session/exercise the read
// side wouldn't have shown her. A member may only see/log a session's
// workout once she's been marked actually present — markActualAttendance.ts's
// RegistrationItem.actualAttendance === 'present', not just her own RSVP
// (declaredAttendance) and not just "the date has passed" — and only for
// the assigned Workout Plan's sections the admin flagged `measurable` (see
// WorkoutPlanBlockItem).
export async function resolveMeasurableSessionWorkout(
  uid: string,
  classId: string,
): Promise<ResolveSessionWorkoutResult> {
  const [regRes, sessionRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: `REG#${uid}` } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
  ]);

  const registration = regRes.Item as RegistrationItem | undefined;
  if (!registration || registration.actualAttendance !== 'present') {
    return { ok: false, status: 403, error: 'not_attended' };
  }

  const session = sessionRes.Item as ClassItem | undefined;
  if (!session) return { ok: false, status: 404, error: 'session_not_found' };
  if (!session.workoutPlanId) return { ok: false, status: 404, error: 'no_workout_plan' };

  const blocksRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${session.workoutPlanId}`, ':prefix': 'BLOCK#' },
  }));
  const measurableSections = ((blocksRes.Items ?? []) as (WorkoutPlanBlockItem & { PK: string; SK: string })[])
    .filter((b) => b.mode === 'stations' && b.measurable === true)
    .sort((a, b) => a.order - b.order);

  return { ok: true, session, planId: session.workoutPlanId, planName: session.workoutPlanName ?? '', measurableSections };
}
