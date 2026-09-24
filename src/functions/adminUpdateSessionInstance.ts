import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem } from '../lib/entities';

// POST /adminUpdateSessionInstance
// Body: { classId: string, date?: string, coachId?: string | null, coachName?: string | null, location?: string | null }
// Auth: Cognito JWT, admin-only — same gating as adminSaveRecurringSession.ts.
// Rescheduling touches who's assigned/when, a scheduling-management action,
// not a coach's own session-running action (compare sessionInAccess()'s
// callers, which gate attendance/equipment/workoutPlan on a coach's own
// assigned sessions instead).
//
// Edits exactly ONE dated session instance without touching its recurring
// template or any other instance — the gap adminSaveRecurringSession.ts's
// own template-level edit can't fill (changing the template's day/time/
// groupId deletes and regenerates every future instance instead — see
// deleteFutureInstances()). If this instance's template is later edited in
// a way that regenerates instances, this edit is lost along with any other
// per-instance customization (workoutPlanId, equipmentTaken, the new
// isTestSession/testGroupId below) — an accepted, pre-existing limitation,
// not new here. No closedAt guard: admin already has unrestricted override
// on a closed session everywhere else (see entities.ts's ClassItem.closedAt
// comment), and correcting a closed session's recorded coach/location is a
// legitimate admin action.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; date?: unknown; coachId?: unknown; coachName?: unknown; location?: unknown };
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

  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (typeof body.date === 'string' && body.date) {
    sets.push('#date = :date');
    names['#date'] = 'date';
    values[':date'] = body.date;
  }
  if (body.coachId === null) {
    removes.push('coachId', 'coachName');
  } else if (typeof body.coachId === 'string' && body.coachId) {
    sets.push('coachId = :coachId', 'coachName = :coachName');
    values[':coachId'] = body.coachId;
    values[':coachName'] = typeof body.coachName === 'string' ? body.coachName : '';
  }
  if (body.location === null) {
    removes.push('#loc');
    names['#loc'] = 'location';
  } else if (typeof body.location === 'string' && body.location) {
    sets.push('#loc = :location');
    names['#loc'] = 'location';
    values[':location'] = body.location;
  }

  if (sets.length === 0 && removes.length === 0) return json(400, { error: 'no_fields_to_update' });

  const expressionParts: string[] = [];
  if (sets.length > 0) expressionParts.push(`SET ${sets.join(', ')}`);
  if (removes.length > 0) expressionParts.push(`REMOVE ${removes.join(', ')}`);

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: classKey,
    UpdateExpression: expressionParts.join(' '),
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
  }));

  return json(200, { success: true });
}
