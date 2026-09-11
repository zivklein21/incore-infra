import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import type { ClassItem } from '../lib/entities';

// POST /markActualAttendance
// Body: { classId: string, memberId: string, actualAttendance: 'present' | 'absent' }
// Auth: Cognito JWT, caller must have attendance:'write' (admin always does —
// see getCoachAccess.ts) AND the session's group must be one of her assigned
// groups.
//
// This is deliberately the only write action a coach account can have
// anywhere in the FORCA Coach feature — every other coach-accessible
// endpoint (getCoachSessions.ts) is read-only. Updates the RegistrationItem
// createTrainingSession.ts auto-created; never touches declaredAttendance
// (that's the trainee's own field — see declareAttendance.ts).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance !== 'write') return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; memberId?: unknown; actualAttendance?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const actualAttendance = body.actualAttendance === 'present' || body.actualAttendance === 'absent'
    ? body.actualAttendance : null;
  if (!classId || !memberId || !actualAttendance) return json(400, { error: 'missing_required_fields' });

  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });
  if (session.closedAt && !access.isAdmin) return json(403, { error: 'session_closed' });

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: `REG#${memberId}` },
    UpdateExpression: 'SET actualAttendance = :val',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':val': actualAttendance },
  }));

  return json(200, { success: true });
}
