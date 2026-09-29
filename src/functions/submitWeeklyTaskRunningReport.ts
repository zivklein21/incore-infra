import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem, WeeklyTaskCompletionItem, WeeklyTaskItem } from '../lib/entities';

// POST /submitWeeklyTaskRunningReport
// Body: { taskId: string, perceivedExertion: number (1-10), averagePace: string }
// Auth: Cognito JWT, any signed-in FORCA member — always writes her own
// report, same "only she can log her own working weight" convention as
// saveRunningReport.ts/logWeeklyTaskExercise.ts. Rejects a task she isn't
// actually a target of (same isTarget check as toggleWeeklyTaskCompletion.ts/
// logWeeklyTaskExercise.ts), or a task that isn't running.
//
// One-shot, not append-only — a running weekly task's own completion IS
// the report (see WeeklyTaskCompletionItem's own doc comment), unlike
// RunningReportItem's per-session record keyed by classId. Submitting
// again overwrites the same completion row rather than accumulating
// duplicate reports, same upsert convention saveRunningReport.ts uses for
// a session's own report.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { taskId?: unknown; perceivedExertion?: unknown; averagePace?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId) return json(400, { error: 'missing_task_id' });
  const perceivedExertion = typeof body.perceivedExertion === 'number' ? body.perceivedExertion : NaN;
  if (!Number.isInteger(perceivedExertion) || perceivedExertion < 1 || perceivedExertion > 10) {
    return json(400, { error: 'invalid_perceived_exertion' });
  }
  const averagePace = typeof body.averagePace === 'string' ? body.averagePace.trim() : '';
  if (!averagePace) return json(400, { error: 'missing_average_pace' });

  const taskRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WEEKLYTASK#${taskId}`, SK: 'METADATA' } }));
  const task = taskRes.Item as WeeklyTaskItem | undefined;
  if (!task) return json(404, { error: 'task_not_found' });
  if (!task.running) return json(400, { error: 'task_not_running' });

  let isTarget = false;
  if (task.targetType === 'trainees') {
    isTarget = !!task.traineeIds?.includes(callerUid);
  } else {
    const profileRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' } }));
    const profile = profileRes.Item as MemberProfileItem | undefined;
    isTarget = !!profile?.identity?.groupId && profile.identity.groupId === task.groupId;
  }
  if (!isTarget) return json(403, { error: 'not_a_target' });

  const nowIso = new Date().toISOString();
  const item: WeeklyTaskCompletionItem = {
    PK: `WEEKLYTASK#${taskId}`,
    SK: `COMPLETION#${callerUid}`,
    GSI1PK: `MEMBER#${callerUid}`,
    GSI1SK: `WEEKLYTASKCOMPLETION#${taskId}`,
    taskId,
    userId: callerUid,
    completed: true,
    completedAt: nowIso,
    perceivedExertion,
    averagePace,
  };
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, completed: true, completedAt: nowIso });
}
