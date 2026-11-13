import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem } from '../lib/entities';
import { dayIndexKeys, syncRegistrationsAfterMove } from '../lib/sessionMove';
import { ACTIVITY_TEXT_FIELDS, cleanActivityText, cleanEquipmentList } from '../lib/activityDetails';
import { formsSignedOnOlderDetails } from '../lib/formTemplates/activityForms';

// POST /adminUpdateSessionInstance
// Body: { classId: string, date?: string, endDate?: string | null, coachId?: string | null, coachName?: string | null, location?: string | null, manualEquipment?: { equipmentId: string, quantity: number }[] | null,
//         special activities only: className?, description?, transport?, safetyNotes? (string | null), traineeEquipment?: string[] | null }
// Returns { success, signedOnOlderDetails: [...] } — for an activity with forms
// attached, the families who already signed details this edit changed (their
// signed copies and PDFs keep what they signed; see formTemplates/activityFields.ts).
// A new date moves the session's day index (GSI2PK/SK) and every
// registration's classDate with it — see lib/sessionMove.ts.
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

  let body: {
    classId?: unknown; date?: unknown; endDate?: unknown; coachId?: unknown; coachName?: unknown; location?: unknown; manualEquipment?: unknown;
    className?: unknown; description?: unknown; transport?: unknown; safetyNotes?: unknown; traineeEquipment?: unknown;
  };
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

  let movedTo: Date | null = null;
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (typeof body.date === 'string' && body.date) {
    const next = new Date(body.date);
    if (Number.isNaN(next.getTime())) return json(400, { error: 'invalid_date' });
    sets.push('#date = :date', 'GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk');
    names['#date'] = 'date';
    values[':date'] = next.toISOString();
    const keys = dayIndexKeys(classId, next);
    values[':gsi2pk'] = keys.GSI2PK;
    values[':gsi2sk'] = keys.GSI2SK;
    movedTo = next;
  }
  if (body.endDate === null) {
    removes.push('endDate');
  } else if (typeof body.endDate === 'string' && body.endDate) {
    sets.push('endDate = :endDate');
    values[':endDate'] = body.endDate;
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
  if (body.manualEquipment === null) {
    removes.push('manualEquipment');
  } else if (Array.isArray(body.manualEquipment)) {
    const seen = new Set<string>();
    const entries: { equipmentId: string; quantity: number }[] = [];
    for (const raw of body.manualEquipment) {
      if (typeof raw !== 'object' || raw === null) continue;
      const equipmentId = typeof (raw as Record<string, unknown>).equipmentId === 'string' ? (raw as Record<string, unknown>).equipmentId as string : '';
      if (!equipmentId.trim() || seen.has(equipmentId)) continue;
      const rawQuantity = (raw as Record<string, unknown>).quantity;
      const quantity = typeof rawQuantity === 'number' && Number.isFinite(rawQuantity) && rawQuantity >= 1 ? Math.floor(rawQuantity) : 1;
      seen.add(equipmentId);
      entries.push({ equipmentId, quantity });
    }
    if (entries.length > 0) { sets.push('manualEquipment = :manualEquipment'); values[':manualEquipment'] = entries; }
    else { removes.push('manualEquipment'); }
  }

  // A special activity's own details (Manage → Activities). A training's name comes from its training type — not editable here.
  const isActivity = (session as { isSpecialActivity?: boolean }).isSpecialActivity === true;
  for (const field of ACTIVITY_TEXT_FIELDS) {
    const value = cleanActivityText(body[field], field);
    if (value === undefined) continue;
    if (!isActivity) return json(400, { error: 'not_an_activity' });
    if (field === 'className') {
      if (!value) return json(400, { error: 'missing_name' });
      sets.push('className = :className'); values[':className'] = value;
    } else if (value) {
      sets.push(`#${field} = :${field}`); names[`#${field}`] = field; values[`:${field}`] = value;
    } else {
      removes.push(`#${field}`); names[`#${field}`] = field;
    }
  }
  if (body.traineeEquipment !== undefined) {
    if (!isActivity) return json(400, { error: 'not_an_activity' });
    const items = cleanEquipmentList(body.traineeEquipment);
    if (!items) return json(400, { error: 'invalid_equipment' });
    if (items.length) { sets.push('traineeEquipment = :traineeEquipment'); values[':traineeEquipment'] = items; }
    else removes.push('traineeEquipment');
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

  // Registrations follow the session to its new date (sessionMove.ts).
  if (movedTo) await syncRegistrationsAfterMove(FORCA_TABLE_NAME, classId, new Date(session.date), movedTo);

  // Forms attached to this session (activities) whose signed details just went out of date.
  let signedOnOlderDetails: Awaited<ReturnType<typeof formsSignedOnOlderDetails>> = [];
  try {
    signedOnOlderDetails = await formsSignedOnOlderDetails('forca', classId);
  } catch (err) {
    console.warn('[adminUpdateSessionInstance] signed-forms check failed', classId, err);
  }
  return json(200, { success: true, signedOnOlderDetails });
}
