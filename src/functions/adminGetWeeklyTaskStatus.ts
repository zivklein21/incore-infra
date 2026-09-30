import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getAllMemberProfiles } from '../lib/memberScan';
import { deriveMemberName, type MemberProfileItem, type WeeklyTaskCompletionItem, type WeeklyTaskItem } from '../lib/entities';

// GET or POST /adminGetWeeklyTaskStatus?taskId=...
// Auth: Cognito JWT, admin-only — the Weekly Tasks management screen's own
// "who's done, who hasn't" follow-up view, resolved on demand per task
// (not pre-loaded for the whole list, since a group's live roster needs a
// Scan). Unlike getGroupWeeklyTaskStatus.ts — scoped to one group, used
// from a training session's own detail panel, and explicitly out of scope
// for trainees-targeted tasks (a trainees-targeted task has no groupId to
// look a roster up by at all) — this works for EITHER targetType, resolving
// the roster from the task's own live group membership OR its own
// hand-picked traineeIds, whichever applies. This is what lets EVERY task
// in the admin list show a follow-up, not just group-targeted ones.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const taskId = event.queryStringParameters?.taskId
    ?? (event.body ? (JSON.parse(event.body) as { taskId?: unknown }).taskId : undefined);
  if (typeof taskId !== 'string' || !taskId) return json(400, { error: 'missing_task_id' });

  const taskRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WEEKLYTASK#${taskId}`, SK: 'METADATA' } }));
  const task = taskRes.Item as WeeklyTaskItem | undefined;
  if (!task) return json(404, { error: 'task_not_found' });

  let roster: { uid: string; name: string }[];
  if (task.targetType === 'group' && task.groupId) {
    // Live roster, same as a training session's own auto-registration — a
    // member who joined the group yesterday shows up today, same tradeoff
    // as getGroupWeeklyTaskStatus.ts's identical Scan.
    const membersRes = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND #identity.groupId = :groupId',
      ExpressionAttributeNames: { '#identity': 'identity' },
      ExpressionAttributeValues: { ':prefix': 'MEMBER#', ':profile': 'PROFILE', ':groupId': task.groupId },
    }));
    roster = ((membersRes.Items ?? []) as MemberProfileItem[])
      .map((p) => ({ uid: (p.PK as string).replace('MEMBER#', ''), name: deriveMemberName(p) }));
  } else {
    const profiles = await getAllMemberProfiles(FORCA_TABLE_NAME);
    const byId = new Map(profiles.map((p) => [(p.PK as string).replace('MEMBER#', ''), p]));
    roster = (task.traineeIds ?? []).map((uid) => {
      const p = byId.get(uid);
      return { uid, name: p ? deriveMemberName(p) : uid };
    });
  }
  roster.sort((a, b) => a.name.localeCompare(b.name));

  const completionsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `WEEKLYTASK#${taskId}`, ':prefix': 'COMPLETION#' },
  }));
  const completedUids = new Set(
    ((completionsRes.Items ?? []) as WeeklyTaskCompletionItem[])
      .filter((c) => c.completed)
      .map((c) => c.userId),
  );

  return json(200, { roster: roster.map((m) => ({ uid: m.uid, name: m.name, completed: completedUids.has(m.uid) })) });
}
