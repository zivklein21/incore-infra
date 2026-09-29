import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { GroupItem, WeeklyTaskItem } from '../lib/entities';

// POST /adminSaveWeeklyTask
// Body: { id?: string, title: string, description?: string, deadline: string (ISO),
//         targetType: 'group' | 'trainees', groupId?: string, traineeIds?: string[], active?: boolean,
//         measurable?: boolean, exerciseIds?: string[], running?: boolean }
// — omit id to create. targetType 'group' requires groupId (every CURRENT
// member of that group is in scope, resolved live — see
// getMyWeeklyTasks.ts/getGroupWeeklyTaskStatus.ts, never a frozen roster
// snapshot); 'trainees' requires a non-empty traineeIds list, independent
// of anyone's current group. measurable: true requires a non-empty
// exerciseIds list (from the Exercises catalog — see getExercises.ts).
// measurable and running are mutually exclusive — a task is one type or
// the other, never both (see WeeklyTaskItem's own doc comment for what
// each changes about completion).
// Auth: Cognito JWT, admin-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; title?: unknown; description?: unknown; deadline?: unknown;
    targetType?: unknown; groupId?: unknown; traineeIds?: unknown; active?: unknown;
    measurable?: unknown; exerciseIds?: unknown; running?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return json(400, { error: 'missing_title' });
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : undefined;
  const deadlineDate = typeof body.deadline === 'string' ? new Date(body.deadline) : null;
  if (!deadlineDate || Number.isNaN(deadlineDate.getTime())) return json(400, { error: 'invalid_deadline' });
  const deadline = deadlineDate.toISOString();

  const targetType = body.targetType === 'group' || body.targetType === 'trainees' ? body.targetType : null;
  if (!targetType) return json(400, { error: 'invalid_target_type' });

  let groupId: string | undefined;
  let groupName: string | undefined;
  let traineeIds: string[] | undefined;

  if (targetType === 'group') {
    groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
    if (!groupId) return json(400, { error: 'missing_group_id' });
    const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } }));
    const group = groupRes.Item as GroupItem | undefined;
    if (!group) return json(404, { error: 'group_not_found' });
    groupName = group.name;
  } else {
    traineeIds = Array.isArray(body.traineeIds)
      ? [...new Set(body.traineeIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))]
      : [];
    if (traineeIds.length === 0) return json(400, { error: 'missing_trainee_ids' });
  }

  const measurable = body.measurable === true;
  const running = body.running === true;
  if (measurable && running) return json(400, { error: 'measurable_and_running_are_exclusive' });
  let exerciseIds: string[] | undefined;
  if (measurable) {
    exerciseIds = Array.isArray(body.exerciseIds)
      ? [...new Set(body.exerciseIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))]
      : [];
    if (exerciseIds.length === 0) return json(400, { error: 'missing_exercise_ids' });
  }

  const active = body.active !== false;
  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WEEKLYTASK#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as WeeklyTaskItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: WeeklyTaskItem = {
    PK: `WEEKLYTASK#${id}`,
    SK: 'METADATA',
    GSI2PK: 'WEEKLYTASK',
    GSI2SK: `${deadline}#${id}`,
    title,
    ...(description ? { description } : {}),
    deadline,
    targetType,
    ...(groupId ? { groupId, groupName } : {}),
    ...(traineeIds ? { traineeIds } : {}),
    active,
    measurable,
    ...(exerciseIds ? { exerciseIds } : {}),
    running,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
