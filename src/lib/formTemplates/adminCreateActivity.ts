import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { createSessionInstance } from '../sessionInstance';
import { assignForm } from './adminAssignFormTemplate';
import { cleanActivityText, cleanEquipmentList } from '../activityDetails';

// POST /adminCreateActivity
// Body: { name, description?, date (ISO, carries the time), endTime? ("HH:mm"), location?, groupId,
//         transport?, safetyNotes?, equipment?: string[] ("what to bring"),
//         forms: [{ templateId, adminAnswers? }], notify?: boolean }
// Auth: Cognito JWT, admin only. FORCA.
//
// Manage → Activities → Create activity: a SPECIAL ACTIVITY (a trip, an
// event…) in the calendar — the same session item createTrainingSession.ts
// makes (so it shows in the calendar and the whole group is registered
// automatically), but with its own name + description and no training type
// (sessionInstance.ts `activity`). Each chosen form is then attached to it
// (assignForm, target 'activity'): every registered trainee's family gets
// it in "Forms to sign" before the activity; admin event fields linked to
// the activity (activity.name / date / time / endTime / location / transport
// / equipment / safetyNotes / description) fill themselves, and follow later
// edits of the activity until signed (activityFields.ts).
//
// Returns { classId, forms: [{ templateId, ok, assignmentId?, error? }] } —
// the activity is created even if attaching a form fails (that form can be
// attached again from Assign & track → An activity).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: {
    name?: unknown; description?: unknown; date?: unknown; endTime?: unknown; location?: unknown; groupId?: unknown;
    transport?: unknown; safetyNotes?: unknown; equipment?: unknown;
    forms?: unknown; notify?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const name = cleanActivityText(body.name, 'className') ?? '';
  const groupId = typeof body.groupId === 'string' ? body.groupId : '';
  const date = typeof body.date === 'string' ? new Date(body.date) : null;
  if (!name || !groupId || !date || Number.isNaN(date.getTime())) return json(400, { error: 'missing_fields', required: ['name', 'groupId', 'date'] });
  const equipment = body.equipment === undefined ? [] : cleanEquipmentList(body.equipment);
  if (!equipment) return json(400, { error: 'invalid_equipment' });
  const endTime = typeof body.endTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.endTime) ? body.endTime : undefined;

  const created = await createSessionInstance({
    groupId,
    trainingTypeId: '',
    date,
    endTime,
    location: typeof body.location === 'string' && body.location.trim() ? body.location.trim().slice(0, 200) : undefined,
    createdBy: uid,
    activity: {
      name,
      description: cleanActivityText(body.description, 'description') || undefined,
      transport: cleanActivityText(body.transport, 'transport') || undefined,
      safetyNotes: cleanActivityText(body.safetyNotes, 'safetyNotes') || undefined,
    },
    traineeEquipment: equipment,
  });
  if (!created.ok) return json(400, { error: created.error });

  const forms = (Array.isArray(body.forms) ? body.forms : []).slice(0, 10) as { templateId?: unknown; adminAnswers?: unknown }[];
  const results = [];
  for (const f of forms) {
    const templateId = typeof f?.templateId === 'string' ? f.templateId : '';
    if (!templateId) continue;
    const res = await assignForm({
      brand: 'forca', templateId, target: { kind: 'activity', classId: created.classId }, adminAnswers: f.adminAnswers, notify: body.notify !== false, uid,
    });
    results.push(res.ok ? { templateId, ok: true, assignmentId: res.assignmentId } : { templateId, ok: false, error: res.body });
  }

  return json(200, { success: true, classId: created.classId, registered: created.registeredCount, forms: results });
}
