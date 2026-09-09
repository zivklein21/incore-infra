import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isCoachOrAdmin } from '../lib/auth';
import { deriveMemberName, type ClassItem, type MemberProfileItem, type RegistrationItem } from '../lib/entities';

// GET or POST /getCoachSessions
// Auth: Cognito JWT, caller must be a coach or admin (isCoachOrAdmin)
//
// Lists every FORCA training session (a ClassItem with a groupId — see
// createTrainingSession.ts) with its full roster: declared + actual
// attendance per auto-registered member. View-only — a coach's one write
// action is markActualAttendance.ts, not this endpoint.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isCoachOrAdmin(callerUid))) return json(403, { error: 'forbidden' });

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getClasses.ts.
  const sessionsRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND attribute_exists(groupId)',
    ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA' },
  }));
  const sessionItems = (sessionsRes.Items ?? []) as (ClassItem & { PK: string; groupId?: string })[];

  const sessions = await Promise.all(sessionItems.map(async (session) => {
    const classId = session.PK.replace('CLASS#', '');
    const regsRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
    }));
    const registrations = (regsRes.Items ?? []) as RegistrationItem[];

    const profiles = await Promise.all(registrations.map((r) =>
      ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${r.userId}`, SK: 'PROFILE' } })),
    ));

    const roster = registrations.map((r, i) => {
      const profile = profiles[i].Item as MemberProfileItem | undefined;
      return {
        memberId: r.userId,
        name: profile ? deriveMemberName(profile) : r.userId,
        declaredAttendance: r.declaredAttendance ?? 'pending',
        actualAttendance: r.actualAttendance ?? null,
      };
    });
    roster.sort((a, b) => a.name.localeCompare(b.name));

    return {
      classId,
      date: session.date,
      className: session.className ?? '',
      groupId: session.groupId ?? '',
      roster,
    };
  }));

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  return json(200, { sessions });
}
