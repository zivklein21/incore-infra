import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ClassItem, TrainingTypeItem, WorkoutPlanItem } from './entities';

// Re-resolves isRunningSession (TrainingType.category === 'running' OR the
// assigned WorkoutPlan.category === 'running' — see entities.ts's
// WorkoutPlanItem.category comment) for every ClassItem matching the given
// trainingTypeId or workoutPlanId, PAST AND FUTURE. Called from
// adminSaveTrainingType.ts / adminSaveWorkoutPlan.ts after a category edit —
// sessionInstance.ts / assignSessionWorkoutPlan.ts only recompute the flag
// at session-creation/plan-assignment time, which is too early to see a
// category edited afterward (e.g. a plan already assigned to a session,
// then tagged running later).
//
// Deliberately NOT the "future only" pattern deleteFutureInstances() uses
// elsewhere (regenerating not-yet-occurred instances after a template
// change) — that convention doesn't apply here. The running post-workout
// report is filled in AFTER a session happens, so the sessions that most
// need this flag are exactly the recent PAST ones a trainee/coach is about
// to report on; restricting to future-only was tried and confirmed (via
// live testing) to leave already-occurred sessions stuck showing the
// regular workout log instead of the running report.
export async function backfillRunningSessions(match: { trainingTypeId?: string; workoutPlanId?: string }): Promise<void> {
  if (!match.trainingTypeId && !match.workoutPlanId) return;

  const filters: string[] = [];
  const values: Record<string, unknown> = {};
  if (match.trainingTypeId) { filters.push('trainingTypeId = :ttid'); values[':ttid'] = match.trainingTypeId; }
  if (match.workoutPlanId) { filters.push('workoutPlanId = :wpid'); values[':wpid'] = match.workoutPlanId; }

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: filters.join(' AND '),
    ExpressionAttributeValues: values,
  }));
  const sessions = (res.Items ?? []) as (ClassItem & { PK: string })[];

  await Promise.all(sessions.map(async (session) => {
    const [trainingTypeRes, workoutPlanRes] = await Promise.all([
      session.trainingTypeId
        ? ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${session.trainingTypeId}`, SK: 'METADATA' } }))
        : Promise.resolve(undefined),
      session.workoutPlanId
        ? ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${session.workoutPlanId}`, SK: 'METADATA' } }))
        : Promise.resolve(undefined),
    ]);
    const trainingTypeIsRunning = (trainingTypeRes?.Item as TrainingTypeItem | undefined)?.category === 'running';
    const workoutPlanIsRunning = (workoutPlanRes?.Item as WorkoutPlanItem | undefined)?.category === 'running';
    const isRunningSession = trainingTypeIsRunning || workoutPlanIsRunning;

    if (isRunningSession === (session.isRunningSession ?? false)) return;

    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: session.PK, SK: 'METADATA' },
      UpdateExpression: isRunningSession ? 'SET isRunningSession = :v' : 'REMOVE isRunningSession',
      ...(isRunningSession ? { ExpressionAttributeValues: { ':v': true } } : {}),
    }));
  }));
}
