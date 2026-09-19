import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, GroupItem, MemberProfileItem, RegistrationItem } from '../lib/entities';

// GET or POST /getMyTrainingSessions
// Auth: Cognito JWT, any signed-in member — returns only the caller's own
// upcoming FORCA training sessions, with her own declaredAttendance/
// declineReason, so CheckInScreen.tsx has something to render and
// declareAttendance.ts something to write to. FORCA-only (querying the
// FORCA table naturally excludes any INCORE registrations — those live in
// a fully separate table, see lib/dynamo.ts's tableForBrand()).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':prefix': 'REG#' },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];

  // Coach phone isn't on ClassItem itself (only coachId/coachName), and a
  // trainee typically has several sessions with the same coach — cached per
  // request so the Trainee Dashboard's "message the coach on WhatsApp"
  // action (client-side wa.me deep link) doesn't cost one extra GetItem per
  // session.
  const coachPhoneCache = new Map<string, string | null>();
  async function resolveCoachPhone(coachId: string | null | undefined): Promise<string | null> {
    if (!coachId) return null;
    if (coachPhoneCache.has(coachId)) return coachPhoneCache.get(coachId)!;
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${coachId}`, SK: 'PROFILE' } }));
    const coachProfile = res.Item as MemberProfileItem | undefined;
    const phone = coachProfile?.identity?.phone ?? coachProfile?.phone ?? null;
    coachPhoneCache.set(coachId, phone);
    return phone;
  }

  // Same cache-per-request rationale as resolveCoachPhone above — groupName
  // isn't denormalized onto ClassItem, only groupId, and a trainee's
  // sessions are almost always all the same group.
  const groupNameCache = new Map<string, string | null>();
  async function resolveGroupName(groupId: string | null | undefined): Promise<string | null> {
    if (!groupId) return null;
    if (groupNameCache.has(groupId)) return groupNameCache.get(groupId)!;
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } }));
    const group = res.Item as GroupItem | undefined;
    const name = group?.name ?? null;
    groupNameCache.set(groupId, name);
    return name;
  }

  const sessions = await Promise.all(registrations.map(async (r) => {
    const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } }));
    const session = classRes.Item as ClassItem | undefined;
    if (!session) return null;
    return {
      classId: r.classId,
      date: session.date,
      className: session.className ?? '',
      location: session.location ?? null,
      coachName: session.coachName ?? null,
      coachPhone: await resolveCoachPhone(session.coachId),
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
