import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getAllMemberProfiles } from '../lib/memberScan';
import { deriveMemberName, type ExerciseDefinitionItem, type WeeklyTaskItem } from '../lib/entities';

// GET or POST /adminListWeeklyTasks
// Auth: Cognito JWT, admin-only.
// Full task list for the Weekly Tasks management screen, deadline-ascending
// (GSI2PK='WEEKLYTASK', same "no Scan needed" convention as
// WeeklyTaskItem.GSI2SK's own doc comment) — trainee-targeted tasks get
// their raw traineeIds resolved to display names here (never stored
// denormalized, since a trainee's own name can change and this list is the
// only place it's ever shown back to an admin).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': 'WEEKLYTASK' },
  }));
  const tasks = (res.Items ?? []) as WeeklyTaskItem[];

  const needsNames = tasks.some((t) => t.targetType === 'trainees');
  const nameById = new Map<string, string>();
  if (needsNames) {
    const profiles = await getAllMemberProfiles(FORCA_TABLE_NAME);
    for (const p of profiles) nameById.set((p.PK as string).replace('MEMBER#', ''), deriveMemberName(p));
  }

  const needsExercises = tasks.some((t) => t.measurable);
  const exerciseNameById = new Map<string, string>();
  if (needsExercises) {
    const exercisesRes = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'EXERCISE#', ':metadata': 'METADATA' },
    }));
    for (const e of (exercisesRes.Items ?? []) as (ExerciseDefinitionItem & { PK: string })[]) {
      exerciseNameById.set(e.PK.replace('EXERCISE#', ''), e.name);
    }
  }

  const result = tasks.map((t) => ({
    id: t.PK.replace('WEEKLYTASK#', ''),
    title: t.title,
    description: t.description ?? null,
    deadline: t.deadline,
    targetType: t.targetType,
    groupId: t.groupId ?? null,
    groupName: t.groupName ?? null,
    traineeIds: t.traineeIds ?? null,
    traineeNames: t.traineeIds ? t.traineeIds.map((id) => nameById.get(id) ?? id) : null,
    active: t.active,
    measurable: !!t.measurable,
    exerciseIds: t.exerciseIds ?? null,
    exerciseNames: t.exerciseIds ? t.exerciseIds.map((id) => exerciseNameById.get(id) ?? id) : null,
    running: !!t.running,
  }));

  return json(200, { tasks: result });
}
