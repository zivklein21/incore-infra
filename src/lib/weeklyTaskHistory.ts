import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import type { ExerciseDefinitionItem, MemberProfileItem, WeeklyTaskCompletionItem, WeeklyTaskItem } from './entities';

export interface WeeklyTaskHistoryEntry {
  id: string;
  title: string;
  description: string | null;
  deadline: string; // ISO 8601
  /** Soft-disabled tasks still show here — this is a HISTORY view (like
   * ExerciseLogEntryItem's own history), not the active-only "what's due
   * now" list getMyWeeklyTasks.ts/getGroupWeeklyTaskStatus.ts serve. */
  active: boolean;
  completed: boolean;
  completedAt: string | null;
  measurable: boolean;
  exerciseNames: string[] | null;
  running: boolean;
  perceivedExertion: number | null;
  averagePace: string | null;
}

// Shared by getMyWeeklyTaskHistory.ts / getChildWeeklyTaskHistory.ts /
// getMemberWeeklyTaskHistory.ts — the FORCA Tracker's own "Weekly Tasks"
// section for one member (trainee reviewing her own, parent reviewing her
// child's, admin/coach reviewing any trainee's), so the three call sites
// never drift on what "this member's weekly-task history" means. Targeting
// (group vs. individual pick) uses the member's CURRENT groupId, same "live
// membership, not a frozen snapshot" convention as getMyWeeklyTasks.ts and
// every other group-membership check in this codebase — a task from a group
// she's since left won't appear, an accepted pre-existing limitation, not
// new here.
export async function resolveMemberWeeklyTaskHistory(
  tableName: string,
  memberUid: string,
): Promise<WeeklyTaskHistoryEntry[]> {
  const profileRes = await ddb.send(new GetCommand({ TableName: tableName, Key: { PK: `MEMBER#${memberUid}`, SK: 'PROFILE' } }));
  const profile = profileRes.Item as MemberProfileItem | undefined;
  const groupId = profile?.identity?.groupId;

  const tasksRes = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': 'WEEKLYTASK' },
  }));
  const allTasks = (tasksRes.Items ?? []) as WeeklyTaskItem[];

  const myTasks = allTasks.filter((t) => {
    if (t.targetType === 'group') return !!groupId && t.groupId === groupId;
    return !!t.traineeIds?.includes(memberUid);
  });

  const needsExercises = myTasks.some((t) => t.measurable);
  const exerciseNameById = new Map<string, string>();
  if (needsExercises) {
    const exercisesRes = await ddb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'EXERCISE#', ':metadata': 'METADATA' },
    }));
    for (const e of (exercisesRes.Items ?? []) as (ExerciseDefinitionItem & { PK: string })[]) {
      exerciseNameById.set(e.PK.replace('EXERCISE#', ''), e.name);
    }
  }

  const withCompletion = await Promise.all(myTasks.map(async (t) => {
    const id = t.PK.replace('WEEKLYTASK#', '');
    const completionRes = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { PK: t.PK, SK: `COMPLETION#${memberUid}` },
    }));
    const completion = completionRes.Item as WeeklyTaskCompletionItem | undefined;

    return {
      id,
      title: t.title,
      description: t.description ?? null,
      deadline: t.deadline,
      active: t.active,
      completed: completion?.completed === true,
      completedAt: completion?.completedAt ?? null,
      measurable: !!t.measurable,
      exerciseNames: t.measurable && t.exerciseIds ? t.exerciseIds.map((exId) => exerciseNameById.get(exId) ?? exId) : null,
      running: !!t.running,
      perceivedExertion: completion?.perceivedExertion ?? null,
      averagePace: completion?.averagePace ?? null,
    };
  }));

  withCompletion.sort((a, b) => b.deadline.localeCompare(a.deadline));
  return withCompletion;
}
