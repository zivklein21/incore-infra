import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import { fetchSessionLookups, resolveSessionDetail, type RosterEntryDetail } from '../lib/sessionDetail';
import type { ClassItem } from '../lib/entities';

// GET or POST /getTrainingHistory
// Auth: Cognito JWT, caller must be admin (Backoffice-only — not a coach
// feature, unlike getCoachSessions.ts).
//
// Lists every past FORCA training session (date < now), built on the same
// resolveSessionDetail() getCoachSessions.ts uses, with each roster entry
// additionally carrying attendanceMatch: whether the trainee's own
// self-reported arrival (declaredAttendance — declareAttendance.ts) matches
// what the coach actually recorded (actualAttendance — markActualAttendance.ts).
// null when there's nothing to compare yet (actual never recorded, or the
// trainee never declared) — a genuine "no signal" case, not a mismatch.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access?.isAdmin) return json(403, { error: 'forbidden' });

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getCoachSessions.ts.
  const nowIso = new Date().toISOString();
  const sessionsRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND attribute_exists(groupId) AND #dt < :now',
    ExpressionAttributeNames: { '#dt': 'date' },
    ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA', ':now': nowIso },
  }));
  const sessionItems = (sessionsRes.Items ?? []) as (ClassItem & { PK: string })[];

  const lookups = await fetchSessionLookups(sessionItems);
  const sessions = await Promise.all(sessionItems.map(async (session) => {
    const detail = await resolveSessionDetail(session, lookups, access);
    const roster = detail.roster.map((r) => ({ ...r, attendanceMatch: computeAttendanceMatch(r) }));
    return { ...detail, roster };
  }));

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  return json(200, { sessions });
}

function computeAttendanceMatch(entry: RosterEntryDetail): boolean | null {
  if (entry.actualAttendance === null || entry.declaredAttendance === 'pending') return null;
  const declaredYes = entry.declaredAttendance === 'yes';
  const actualPresent = entry.actualAttendance === 'present';
  return declaredYes === actualPresent;
}
