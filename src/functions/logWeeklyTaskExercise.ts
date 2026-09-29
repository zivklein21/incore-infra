import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import {
  measurementValueSatisfies,
  type ExerciseDefinitionItem,
  type MemberProfileItem,
  type WeeklyTaskCompletionItem,
  type WeeklyTaskExerciseLogItem,
  type WeeklyTaskItem,
} from '../lib/entities';

// POST /logWeeklyTaskExercise
// Body: { taskId: string, exerciseId: string, value: { weight?, reps?, timeSeconds?, bandLevel? } }
// Auth: Cognito JWT, any signed-in FORCA member — always writes her own log,
// same "only she can log her own working weight" convention as
// logSessionExercise.ts. Rejects a task she isn't actually a target of
// (same isTarget check as toggleWeeklyTaskCompletion.ts), a task that isn't
// measurable, or an exerciseId not attached to this task.
//
// Measurable-task completion is a side effect of logging, not a separate
// toggle: after writing this exercise's WeeklyTaskExerciseLogItem, checks
// whether she now has one for every exerciseId on the task and, if so,
// upserts her WeeklyTaskCompletionItem — same completed/completedAt shape
// toggleWeeklyTaskCompletion.ts writes, so getGroupWeeklyTaskStatus.ts's
// coach tracker keeps working unmodified either way.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { taskId?: unknown; exerciseId?: unknown; value?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId) return json(400, { error: 'missing_task_id' });
  const exerciseId = typeof body.exerciseId === 'string' ? body.exerciseId.trim() : '';
  if (!exerciseId) return json(400, { error: 'missing_exercise_id' });

  const taskRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WEEKLYTASK#${taskId}`, SK: 'METADATA' } }));
  const task = taskRes.Item as WeeklyTaskItem | undefined;
  if (!task) return json(404, { error: 'task_not_found' });
  if (!task.measurable) return json(400, { error: 'task_not_measurable' });
  if (!task.exerciseIds?.includes(exerciseId)) return json(400, { error: 'exercise_not_on_task' });

  let isTarget = false;
  if (task.targetType === 'trainees') {
    isTarget = !!task.traineeIds?.includes(callerUid);
  } else {
    const profileRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' } }));
    const profile = profileRes.Item as MemberProfileItem | undefined;
    isTarget = !!profile?.identity?.groupId && profile.identity.groupId === task.groupId;
  }
  if (!isTarget) return json(403, { error: 'not_a_target' });

  const exerciseRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${exerciseId}`, SK: 'METADATA' } }));
  const exercise = exerciseRes.Item as ExerciseDefinitionItem | undefined;
  if (!exercise) return json(404, { error: 'exercise_not_found' });

  const raw = body.value && typeof body.value === 'object' ? body.value as Record<string, unknown> : {};
  const value: WeeklyTaskExerciseLogItem['value'] = {
    ...(typeof raw.weight === 'number' ? { weight: raw.weight } : {}),
    ...(typeof raw.reps === 'number' ? { reps: raw.reps } : {}),
    ...(typeof raw.timeSeconds === 'number' ? { timeSeconds: raw.timeSeconds } : {}),
    ...(typeof raw.bandLevel === 'string' && raw.bandLevel ? { bandLevel: raw.bandLevel } : {}),
  };
  if (!measurementValueSatisfies(exercise.measurementType, value)) return json(400, { error: 'missing_value' });

  const nowIso = new Date().toISOString();
  const logItem: WeeklyTaskExerciseLogItem = {
    PK: `WEEKLYTASK#${taskId}`,
    SK: `TASKLOG#${callerUid}#${exerciseId}`,
    taskId,
    userId: callerUid,
    exerciseId,
    exerciseName: exercise.name,
    measurementType: exercise.measurementType,
    value,
    loggedAt: nowIso,
  };
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: logItem }));

  const loggedRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `WEEKLYTASK#${taskId}`, ':prefix': `TASKLOG#${callerUid}#` },
  }));
  const loggedExerciseIds = new Set(
    ((loggedRes.Items ?? []) as WeeklyTaskExerciseLogItem[]).map((l) => l.exerciseId),
  );
  const allLogged = task.exerciseIds.every((id) => loggedExerciseIds.has(id));

  let completed = false;
  let completedAt: string | null = null;
  if (allLogged) {
    completed = true;
    completedAt = nowIso;
    const completionItem: WeeklyTaskCompletionItem = {
      PK: `WEEKLYTASK#${taskId}`,
      SK: `COMPLETION#${callerUid}`,
      GSI1PK: `MEMBER#${callerUid}`,
      GSI1SK: `WEEKLYTASKCOMPLETION#${taskId}`,
      taskId,
      userId: callerUid,
      completed: true,
      completedAt: nowIso,
    };
    await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: completionItem }));
  }

  return json(200, { success: true, completed, completedAt });
}
