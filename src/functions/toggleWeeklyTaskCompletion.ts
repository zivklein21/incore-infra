import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem, WeeklyTaskCompletionItem, WeeklyTaskItem } from '../lib/entities';

// POST /toggleWeeklyTaskCompletion
// Body: { taskId: string, completed: boolean }
// Auth: Cognito JWT, any signed-in FORCA member — always writes her own
// completion ("עשיתי"/"לא עשיתי"), same "only she can log her own working
// weight" convention as logExercise.ts/logSessionExercise.ts. Rejects a
// task she isn't actually a target of (her current group, or an explicit
// individual pick), same shape check getMyWeeklyTasks.ts's own filter uses.
// Rejects a measurable or running task outright — completion there is a
// side effect of logging every attached exercise (see
// logWeeklyTaskExercise.ts) or submitting the running report (see
// submitWeeklyTaskRunningReport.ts), not a manual toggle.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { taskId?: unknown; completed?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId) return json(400, { error: 'missing_task_id' });
  const completed = body.completed === true;

  const taskRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WEEKLYTASK#${taskId}`, SK: 'METADATA' } }));
  const task = taskRes.Item as WeeklyTaskItem | undefined;
  if (!task) return json(404, { error: 'task_not_found' });
  if (task.measurable) return json(400, { error: 'task_is_measurable' });
  if (task.running) return json(400, { error: 'task_is_running' });

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
    completed,
    completedAt: completed ? nowIso : null,
  };
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, completed, completedAt: item.completedAt });
}
