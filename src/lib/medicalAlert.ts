import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getCoachAccess } from './coachAccess';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { MedicalAlertLogEntry, MemberProfileItem } from './entities';
import { getUid, json } from './http';
import { resolveStaffIdentity } from './staffIdentity';

// FORCA medical alert: the one piece of medical information a coach may see.
// An admin writes a short note ("Asthma – inhaler in bag") on the trainee's
// profile. Everything else medical (health declaration, questionnaire answers,
// medical forms) stays with the admin, the trainee and her parent, and no
// coach-reachable endpoint may return it or anything derived from it.

export const MEDICAL_ALERT_MAX = 200;

/** What staff get on the attendance list and in test grading: the text while the alert is on, otherwise null. */
export function activeMedicalAlert(profile: MemberProfileItem | null | undefined): string | null {
  const alert = profile?.medicalAlert;
  return alert?.enabled && alert.text ? alert.text : null;
}

export type ParsedMedicalAlert =
  | { ok: true; enabled: boolean; text: string }
  | { ok: false; error: 'invalid_argument' | 'text_required' | 'text_too_long' };

/** Turning an alert off keeps its text, so it can be turned back on without retyping. */
export function parseMedicalAlert(body: { enabled?: unknown; text?: unknown }): ParsedMedicalAlert {
  if (typeof body.enabled !== 'boolean' || typeof body.text !== 'string') return { ok: false, error: 'invalid_argument' };
  const text = body.text.trim();
  if (text.length > MEDICAL_ALERT_MAX) return { ok: false, error: 'text_too_long' };
  if (body.enabled && !text) return { ok: false, error: 'text_required' };
  return { ok: true, enabled: body.enabled, text };
}

function logAction(previous: MemberProfileItem['medicalAlert'], next: { enabled: boolean; text: string }): MedicalAlertLogEntry['action'] {
  if (!previous) return 'created';
  if (previous.text !== next.text) return 'changed';
  return next.enabled ? 'turned_on' : 'turned_off';
}

// POST /adminSetMedicalAlert
// Body: { memberId: string, enabled: boolean, text: string }
// Auth: Cognito JWT, admin only — coaches read the alert but never write it.
// Rides incoreWorkoutApi.ts's shared integration (300-integration cap).
//
// The alert and its log entry go in one UpdateCommand, so a change can't land
// without its log entry. Saving with nothing changed logs nothing.
export async function adminSetMedicalAlert(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access?.isAdmin) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; enabled?: unknown; text?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const parsed = parseMedicalAlert(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const { enabled, text } = parsed;

  const Key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key, ConsistentRead: true }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const previous = profile.medicalAlert;
  if (previous ? previous.enabled === enabled && previous.text === text : !enabled && !text) {
    return json(200, { medicalAlert: previous ?? null });
  }

  const updatedBy = await resolveStaffIdentity(callerUid, access);
  const updatedAt = new Date().toISOString();
  const medicalAlert = { enabled, text, updatedAt, updatedBy };
  const entry: MedicalAlertLogEntry = { at: updatedAt, by: updatedBy, action: logAction(previous, parsed), enabled, text };

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key,
    ConditionExpression: 'attribute_exists(PK)',
    UpdateExpression: 'SET medicalAlert = :alert, medicalAlertLog = list_append(if_not_exists(medicalAlertLog, :none), :entry)',
    ExpressionAttributeValues: { ':alert': medicalAlert, ':none': [], ':entry': [entry] },
  }));

  return json(200, { medicalAlert });
}
