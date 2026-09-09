import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { israelDateStr, type GroupItem, type MemberProfileItem } from '../lib/entities';

// POST /createTrainingSession
// Body: { groupId: string, date: string (ISO 8601), className: string }
// Auth: Cognito JWT, caller must be admin
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

  let body: { groupId?: unknown; date?: unknown; className?: unknown };
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
  const className = typeof body.className === 'string' ? body.className.trim() : '';
  if (!className) return json(400, { error: 'missing_class_name' });

  const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } }));
  const group = groupRes.Item as GroupItem | undefined;
  if (!group) return json(404, { error: 'group_not_found' });

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getAllMemberProfiles()/getClassTypes.ts.
  const membersRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND identity.groupId = :groupId',
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
    className,
    isWaitlistEnabled: false,
    waitlist: [],
    isPrivate: true,
    allowedMemberIds: memberIds,
    groupId,
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
