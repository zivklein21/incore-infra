import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { israelDateStr, type GroupItem, type MemberProfileItem, type TrainingTypeItem } from '../lib/entities';

// POST /createTrainingSession
// Body: { groupId: string, date: string (ISO 8601, carries the picked time
//         too), trainingTypeId: string, repeatWeekly?: boolean, seriesId?: string,
//         location?: string, coachId?: string, coachName?: string }
// Auth: Cognito JWT, caller must be admin
//
// coachId/coachName come from getCoachOptions.ts's merged coach+admin list
// and are stored as-is (denormalized) — see entities.ts's ClassItem comment
// for why this isn't resolved by id on read instead.
//
// trainingTypeId is now required (not just linked equipment) — the session's
// className is derived from it, not typed by the admin, and its equipment
// requirements become the coach's pack list (see getCoachSessions.ts /
// toggleSessionEquipment.ts). notes is set to the Group's name, same idea —
// the admin doesn't type a description either. repeatWeekly/seriesId mirror
// createClass.ts's weekly-series convention exactly (same field names,
// repeat_weekly/series_id, ad hoc/untyped on ClassItem) — the weekly
// expansion itself happens client-side (one call per occurrence), same as
// useCreateClass.ts does for INCORE.
//
// FORCA-only. Unlike createClass.ts, every current member of the group is
// auto-registered immediately — no capacity limit, no individual booking
// call (bypasses bookClass.ts entirely; a coach's/trainee's only relation
// to this is markActualAttendance.ts / a future declare-attendance
// endpoint). isPrivate/allowedMemberIds is set directly here rather than
// via validatePrivateFields() (entities.ts), which forces capacity to 1 for
// one-on-one private classes — that constraint doesn't apply to a group
// session, so this constructs the ClassItem by hand instead.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    groupId?: unknown; date?: unknown; trainingTypeId?: unknown; repeatWeekly?: unknown; seriesId?: unknown;
    location?: unknown; coachId?: unknown; coachName?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  if (!groupId) return json(400, { error: 'missing_group_id' });
  const dateStr = typeof body.date === 'string' ? body.date : '';
  const parsedDate = dateStr ? new Date(dateStr) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime())) return json(400, { error: 'invalid_date' });
  const trainingTypeId = typeof body.trainingTypeId === 'string' ? body.trainingTypeId.trim() : '';
  if (!trainingTypeId) return json(400, { error: 'missing_training_type_id' });
  const repeatWeekly = body.repeatWeekly === true;
  const seriesId = typeof body.seriesId === 'string' && body.seriesId ? body.seriesId : undefined;
  const location = typeof body.location === 'string' && body.location.trim() ? body.location.trim() : undefined;
  const coachId = typeof body.coachId === 'string' && body.coachId ? body.coachId : undefined;
  const coachName = typeof body.coachName === 'string' && body.coachName.trim() ? body.coachName.trim() : undefined;

  const [groupRes, trainingTypeRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${trainingTypeId}`, SK: 'METADATA' } })),
  ]);
  const group = groupRes.Item as GroupItem | undefined;
  if (!group) return json(404, { error: 'group_not_found' });
  const trainingType = trainingTypeRes.Item as TrainingTypeItem | undefined;
  if (!trainingType) return json(404, { error: 'training_type_not_found' });

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getAllMemberProfiles()/getClassTypes.ts. identity is a
  // DynamoDB reserved keyword — bare here it fails every call (see
  // adminUpdateMemberPersonal.ts's #identity alias for the same issue).
  const membersRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND #identity.groupId = :groupId',
    ExpressionAttributeNames: { '#identity': 'identity' },
    ExpressionAttributeValues: { ':prefix': 'MEMBER#', ':profile': 'PROFILE', ':groupId': groupId },
  }));
  const members = (membersRes.Items ?? []) as MemberProfileItem[];
  const memberIds = members.map((m) => (m.PK as string).replace('MEMBER#', ''));
  if (memberIds.length === 0) return json(400, { error: 'group_has_no_members' });

  const classId = randomUUID();
  const nowIso = new Date().toISOString();
  const classItem: Record<string, unknown> = {
    PK: `CLASS#${classId}`,
    SK: 'METADATA',
    GSI2PK: `CLASSDATE#${israelDateStr(parsedDate)}`,
    GSI2SK: `CLASS#${classId}`,
    date: parsedDate.toISOString(),
    capacity: memberIds.length,
    currentAttendeesCount: memberIds.length,
    className: trainingType.name,
    notes: group.name,
    isWaitlistEnabled: false,
    waitlist: [],
    isPrivate: true,
    allowedMemberIds: memberIds,
    groupId,
    trainingTypeId,
    equipmentTaken: [],
    repeat_weekly: repeatWeekly,
    ...(seriesId ? { series_id: seriesId } : {}),
    ...(location ? { location } : {}),
    ...(coachId ? { coachId, coachName } : {}),
    createdAt: nowIso,
    createdBy: callerUid,
  };

  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: classItem,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  await Promise.all(memberIds.map((uid) => ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: {
      PK: `CLASS#${classId}`,
      SK: `REG#${uid}`,
      GSI1PK: `MEMBER#${uid}`,
      GSI1SK: `REG##${classId}`,
      userId: uid,
      classId,
      classDate: classItem.date,
      status: 'REGISTERED',
      consumedFrom: 'FORCA_AUTO',
      membershipId: '',
      targetMonth: '',
      declaredAttendance: 'pending',
      actualAttendance: null,
      registeredAt: nowIso,
    },
  }))));

  return json(200, { success: true, classId, registeredCount: memberIds.length });
}
