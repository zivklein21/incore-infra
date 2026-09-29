import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type {
  ExerciseDefinitionItem,
  ExerciseMeasurementType,
  MemberProfileItem,
  WeeklyTaskCompletionItem,
  WeeklyTaskExerciseLogItem,
  WeeklyTaskItem,
} from '../lib/entities';

// GET or POST /getMyWeeklyTasks
// Auth: Cognito JWT, any signed-in FORCA member — her own active weekly
// tasks, whichever way she was targeted (her CURRENT group, resolved live
// off her own profile — a later group change takes effect immediately, same
// "dynamic, never a frozen roster" convention as WeeklyTaskItem's own doc
// comment — or an explicit individual pick), each with her own completion
// status. Powers the Home dashboard's weekly-tasks card.
//
// A measurable task (see WeeklyTaskItem.measurable) additionally resolves
// each attached exerciseId to its catalog details (name/measurementType/
// bandLevels — same shape getExercises.ts returns, so the client's existing
// StationLogRecorder-style input UI works unmodified) plus whether she's
// already logged it (WeeklyTaskExerciseLogItem — see logWeeklyTaskExercise.ts).
// A running task (see WeeklyTaskItem.running) instead returns her own
// perceivedExertion/averagePace once submitted (see
// submitWeeklyTaskRunningReport.ts) — null until then.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const profileRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' } }));
  const profile = profileRes.Item as MemberProfileItem | undefined;
  const myGroupId = profile?.identity?.groupId;

  // Table documented for <=50 users/tasks per brand elsewhere in this repo —
  // same accepted Scan-equivalent tradeoff, just via the GSI2 partition
  // instead of a bare Scan.
  const tasksRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': 'WEEKLYTASK' },
  }));
  const allTasks = (tasksRes.Items ?? []) as WeeklyTaskItem[];

  const myTasks = allTasks.filter((t) => {
    if (!t.active) return false;
    if (t.targetType === 'group') return !!myGroupId && t.groupId === myGroupId;
    return !!t.traineeIds?.includes(callerUid);
  });

  const needsExercises = myTasks.some((t) => t.measurable);
  const exerciseById = new Map<string, ExerciseDefinitionItem & { PK: string }>();
  if (needsExercises) {
    const exercisesRes = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'EXERCISE#', ':metadata': 'METADATA' },
    }));
    for (const e of (exercisesRes.Items ?? []) as (ExerciseDefinitionItem & { PK: string })[]) {
      exerciseById.set(e.PK.replace('EXERCISE#', ''), e);
    }
  }

  const withCompletion = await Promise.all(myTasks.map(async (t) => {
    const id = t.PK.replace('WEEKLYTASK#', '');
    const completionRes = await ddb.send(new GetCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: t.PK, SK: `COMPLETION#${callerUid}` },
    }));
    const completion = completionRes.Item as WeeklyTaskCompletionItem | undefined;

    let exercises: {
      id: string; name: string; measurementType: ExerciseMeasurementType; bandLevels: string[]; logged: WeeklyTaskExerciseLogItem['value'] | null;
    }[] | null = null;
    if (t.measurable && t.exerciseIds) {
      const logsRes = await ddb.send(new QueryCommand({
        TableName: FORCA_TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': t.PK, ':prefix': `TASKLOG#${callerUid}#` },
      }));
      const loggedByExerciseId = new Map(
        ((logsRes.Items ?? []) as WeeklyTaskExerciseLogItem[]).map((l) => [l.exerciseId, l.value]),
      );
      exercises = t.exerciseIds.map((exId) => {
        const def = exerciseById.get(exId);
        return {
          id: exId,
          name: def?.name ?? exId,
          measurementType: def?.measurementType ?? 'reps_only',
          bandLevels: def?.bandLevels ?? [],
          logged: loggedByExerciseId.get(exId) ?? null,
        };
      });
    }

    return {
      id,
      title: t.title,
      description: t.description ?? null,
      deadline: t.deadline,
      completed: completion?.completed === true,
      completedAt: completion?.completedAt ?? null,
      measurable: !!t.measurable,
      exercises,
      running: !!t.running,
      perceivedExertion: completion?.perceivedExertion ?? null,
      averagePace: completion?.averagePace ?? null,
    };
  }));

  withCompletion.sort((a, b) => a.deadline.localeCompare(b.deadline));

  return json(200, { tasks: withCompletion });
}
