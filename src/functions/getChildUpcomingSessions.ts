import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ClassItem, GroupItem, RegistrationItem } from '../lib/entities';

// GET or POST /getChildUpcomingSessions?childUid=xxx
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of getMyTrainingSessions.ts
// — powers the Parent Home tab's read-only "upcoming session + what she
// declared" view (see the Parent App experience plan). Read-only by design:
// declaring attendance stays the trainee's own action (declareAttendance.ts)
// — there is deliberately no equivalent write endpoint here.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });
  const table = link.table;

  const regsRes = await ddb.send(new QueryCommand({
    TableName: table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'REG#' },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];

  // Same cache-per-request rationale as getMyTrainingSessions.ts's
  // resolveCoachPhone/resolveGroupName — groupName isn't denormalized onto
  // ClassItem, only groupId, and a child's sessions are almost always all
  // the same group.
  const groupNameCache = new Map<string, string | null>();
  async function resolveGroupName(groupId: string | null | undefined): Promise<string | null> {
    if (!groupId) return null;
    if (groupNameCache.has(groupId)) return groupNameCache.get(groupId)!;
    const res = await ddb.send(new GetCommand({ TableName: table, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } }));
    const group = res.Item as GroupItem | undefined;
    const name = group?.name ?? null;
    groupNameCache.set(groupId, name);
    return name;
  }

  const sessions = await Promise.all(registrations.map(async (r) => {
    const classRes = await ddb.send(new GetCommand({ TableName: table, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } }));
    const session = classRes.Item as ClassItem | undefined;
    if (!session) return null;
    return {
      classId: r.classId,
      date: session.date,
      className: session.className ?? '',
      location: session.location ?? null,
      coachName: session.coachName ?? null,
      coachPhone: null,
      groupName: await resolveGroupName(session.groupId),
      declaredAttendance: r.declaredAttendance ?? 'pending',
      declineReason: r.declineReason ?? '',
    };
  }));

  const now = Date.now();
  const upcoming = sessions
    .filter((s): s is NonNullable<typeof s> => !!s && new Date(s.date).getTime() >= now)
    .sort((a, b) => a.date.localeCompare(b.date));

  return json(200, { sessions: upcoming });
}
