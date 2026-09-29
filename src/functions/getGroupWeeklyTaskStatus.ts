import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { deriveMemberName, type MemberProfileItem, type WeeklyTaskCompletionItem, type WeeklyTaskItem } from '../lib/entities';

// GET or POST /getGroupWeeklyTaskStatus?groupId=...
// Auth: Cognito JWT, admin or a coach assigned to this group (groupInAccess)
// — no separate CoachAccess permission axis, same "she can already see this
// group's roster/attendance/equipment unconditionally" visibility model as
// ForcaSessionDetailPanel.tsx's own sections.
//
// Every currently-active group-targeted task for this group, each with the
// group's own CURRENT roster (resolved live, same as a training session's
// auto-registration — a member who joined the group yesterday shows up
// today) and each member's completion status. Trainee-targeted tasks are
// out of scope here — this is specifically the "group's next session"
// status tracker, not a catch-all task list (see adminListWeeklyTasks.ts
// for the full admin view across both target types).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access) return json(403, { error: 'forbidden' });

  const groupId = event.queryStringParameters?.groupId
    ?? (event.body ? (JSON.parse(event.body) as { groupId?: unknown }).groupId : undefined);
  if (typeof groupId !== 'string' || !groupId) return json(400, { error: 'missing_group_id' });
  if (!groupInAccess(access, groupId)) return json(403, { error: 'forbidden' });

  const [tasksRes, membersRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'WEEKLYTASK' },
    })),
    // Same accepted <=50-users-per-brand Scan tradeoff as
    // lib/sessionInstance.ts's createSessionInstance() own group-roster
    // resolution.
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND #identity.groupId = :groupId',
      ExpressionAttributeNames: { '#identity': 'identity' },
      ExpressionAttributeValues: { ':prefix': 'MEMBER#', ':profile': 'PROFILE', ':groupId': groupId },
    })),
  ]);

  const tasks = ((tasksRes.Items ?? []) as WeeklyTaskItem[])
    .filter((t) => t.active && t.targetType === 'group' && t.groupId === groupId)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  const roster = ((membersRes.Items ?? []) as MemberProfileItem[])
    .map((p) => ({ uid: (p.PK as string).replace('MEMBER#', ''), name: deriveMemberName(p) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const result = await Promise.all(tasks.map(async (t) => {
    const id = t.PK.replace('WEEKLYTASK#', '');
    const completionsRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': t.PK, ':prefix': 'COMPLETION#' },
    }));
    const completedUids = new Set(
      ((completionsRes.Items ?? []) as WeeklyTaskCompletionItem[])
        .filter((c) => c.completed)
        .map((c) => c.userId),
    );
    return {
      id,
      title: t.title,
      deadline: t.deadline,
      roster: roster.map((m) => ({ uid: m.uid, name: m.name, completed: completedUids.has(m.uid) })),
    };
  }));

  return json(200, { tasks: result });
}
