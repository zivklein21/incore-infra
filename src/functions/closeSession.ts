import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// POST /closeSession
// Body: { classId: string }
// Auth: Cognito JWT, caller must have attendance:'write' and the session
// must be hers (see sessionInAccess()) — same access as markActualAttendance.ts.
//
// Marks a session done: requires every registered trainee to already have
// actualAttendance recorded and every piece of taken equipment already
// returned (equipmentTaken empty) — the coach's own end-of-session signal
// that there's nothing left to do here. Once closed, markActualAttendance.ts/
// toggleSessionEquipment.ts/returnSessionEquipment.ts all refuse further
// coach edits (admin is exempt — same unrestricted override she has
// everywhere else in this feature).
//
// A session with an empty roster (a group with no active members — see
// sessionInstance.ts's membership gate) vacuously satisfies both checks
// above with nothing to do, which let a session that hadn't even started
// yet be closed. Same "recording opens 5 minutes before start" lower bound
// as markActualAttendance.ts closes that gap here too.
const FIVE_MIN_MS = 5 * 60 * 1000;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance !== 'write') return json(403, { error: 'forbidden' });

  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: classKey }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });
  if (session.closedAt) return json(400, { error: 'already_closed' });
  if (Date.now() < new Date(session.date).getTime() - FIVE_MIN_MS) return json(400, { error: 'too_early' });

  if ((session.equipmentTaken ?? []).length > 0) return json(400, { error: 'equipment_not_returned' });

  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': classKey.PK, ':prefix': 'REG#' },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  if (registrations.some((r) => r.actualAttendance == null)) return json(400, { error: 'attendance_not_complete' });

  const nowIso = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: classKey,
    UpdateExpression: 'SET closedAt = :now, closedBy = :uid',
    ExpressionAttributeValues: { ':now': nowIso, ':uid': callerUid },
  }));

  return json(200, { success: true, closedAt: nowIso });
}
