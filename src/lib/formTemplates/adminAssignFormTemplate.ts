import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ddb } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { getExpoPushToken, sendExpoPushBatch, type ExpoPushMessage } from '../push';
import { formAssignmentKey, parseBrand } from './shared';
import { isCoachForm, DISPLAY_ONLY } from './schema';
import { Answers, answerFormatError, FieldAnswer, isAnswered, visibleIds } from './logic';
import {
  AssignmentTarget, FormAssignmentItem, formsTable, getTemplateHead, getTemplateVersion, listFormPeople, loadRosters, parentOf, getProfile, targetIncludes,
} from './submissions';
import { participatingRoles, rolesOnDevice } from './familyForms';

// POST /adminAssignFormTemplate
// Body (assign):  { templateId, target: { kind: 'all' } | { kind: 'new_members' } | { kind: 'group', groupId, groupName? }
//                   | { kind: 'members', memberIds } | { kind: 'activity', classId },
//                   adminAnswers?: { [adminFieldId]: value }, notify?: boolean, brand }
// Body (cancel):  { action: 'cancel', templateId, assignmentId, brand }
// Auth: Cognito JWT, admin only. Either brand. INCORE's usual target is
// 'new_members' — only members who join after the assignment see it, so no
// existing member is ever asked (groups are FORCA-only). An ACTIVITY target
// (a session/class from the calendar) goes to everyone registered to it —
// re-checked whenever a family opens their forms, so members registered
// later get it too; its name and date are stored for display/deadline.
//
// Assigning is where admin-filled fields (event name, date, location…) get
// their values — required ones must be filled, and every value must pass
// the same format checks a family's answers do. The assignment shows the
// form to every targeted trainee's family (getMyForms.ts) — for "all"/a
// group that includes trainees who join later. notify (default true) sends
// each targeted family a push. Cancelling hides the form from families who
// haven't completed it; existing submissions, signatures and PDFs are kept.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { action?: unknown; templateId?: unknown; assignmentId?: unknown; target?: unknown; adminAnswers?: unknown; notify?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const templateId = typeof body.templateId === 'string' ? body.templateId : '';
  if (!templateId) return json(400, { error: 'missing_template' });
  const brand = parseBrand(body.brand);

  if (body.action === 'cancel') {
    const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : '';
    if (!assignmentId) return json(400, { error: 'missing_assignment' });
    try {
      await ddb.send(new UpdateCommand({
        TableName: formsTable(brand),
        Key: formAssignmentKey(templateId, assignmentId),
        UpdateExpression: 'SET cancelledAt = :now, cancelledBy = :uid',
        ConditionExpression: 'attribute_exists(SK) AND attribute_not_exists(cancelledAt)',
        ExpressionAttributeValues: { ':now': new Date().toISOString(), ':uid': uid },
      }));
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return json(404, { error: 'not_found' });
      throw err;
    }
    return json(200, { success: true });
  }

  const res = await assignForm({ brand, templateId, target: body.target, adminAnswers: body.adminAnswers, notify: body.notify !== false, uid });
  if (!res.ok) return json(res.status, res.body);
  return json(200, { success: true, assignmentId: res.assignmentId, trainees: res.trainees, notified: res.notified });
}

export type AssignResult =
  | { ok: true; assignmentId: string; trainees: number; notified: number }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Admin-field values an activity provides (prefill 'activity.*'): name, date (YYYY-MM-DD), time (HH:mm, Israel), location, description. */
export function activityPrefill(cls: Record<string, unknown>): Record<string, string> {
  const date = typeof cls.date === 'string' ? new Date(cls.date) : null;
  const ok = date && !Number.isNaN(date.getTime());
  const time = ok ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date!) : '';
  return Object.fromEntries(Object.entries({
    'activity.name': typeof cls.className === 'string' ? cls.className : '',
    'activity.date': ok ? date!.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) : '',
    'activity.time': time,
    'activity.location': typeof cls.location === 'string' ? cls.location : '',
    'activity.description': typeof cls.description === 'string' ? cls.description : '',
  }).filter(([, v]) => v));
}

/** Assigns a published template — shared by adminAssignFormTemplate (Assign & track) and adminCreateActivity (forms attached to a new activity). */
export async function assignForm(input: {
  brand: 'incore' | 'forca'; templateId: string; target: unknown; adminAnswers?: unknown; notify?: boolean; uid: string;
}): Promise<AssignResult> {
  const { brand, templateId, uid } = input;
  const head = await getTemplateHead(brand, templateId);
  if (!head) return { ok: false, status: 404, body: { error: 'not_found' } };
  if (head.status !== 'published' || !head.publishedVersion) return { ok: false, status: 409, body: { error: 'not_published' } };
  const t = await getTemplateVersion(brand, templateId, head.publishedVersion);
  if (!t) return { ok: false, status: 404, body: { error: 'not_found' } };

  let activityValues: Record<string, string> = {};
  const raw = (input.target ?? {}) as Record<string, unknown>;
  let target: AssignmentTarget;
  if (raw.kind === 'all') target = { kind: 'all' };
  // A coach form goes to all coaches (incl. ones added later) or specific coaches — nothing trainee-shaped.
  else if (isCoachForm(head.settings) && raw.kind !== 'members') return { ok: false, status: 400, body: { error: 'invalid_target' } };
  else if (raw.kind === 'new_members') target = { kind: 'new_members' };
  else if (raw.kind === 'activity' && typeof raw.classId === 'string' && raw.classId) {
    const cls = (await ddb.send(new GetCommand({ TableName: formsTable(brand), Key: { PK: `CLASS#${raw.classId}`, SK: 'METADATA' } }))).Item;
    if (!cls) return { ok: false, status: 400, body: { error: 'activity_not_found' } };
    target = { kind: 'activity', classId: raw.classId, className: typeof cls.className === 'string' ? cls.className : '', date: String(cls.date ?? '') };
    activityValues = activityPrefill(cls);
  }
  else if (brand === 'forca' && raw.kind === 'group' && typeof raw.groupId === 'string' && raw.groupId) {
    target = { kind: 'group', groupId: raw.groupId, ...(typeof raw.groupName === 'string' ? { groupName: raw.groupName } : {}) };
  } else if (raw.kind === 'members' && Array.isArray(raw.memberIds) && raw.memberIds.length) {
    target = { kind: 'members', memberIds: [...new Set(raw.memberIds.filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 500) };
  } else return { ok: false, status: 400, body: { error: 'invalid_target' } };

  // Admin-filled fields: values for exactly those, validated like family answers.
  const incoming = (input.adminAnswers && typeof input.adminAnswers === 'object' ? input.adminAnswers : {}) as Record<string, FieldAnswer>;
  const adminFields = t.sections.flatMap(s => s.fields).filter(f => f.filledBy === 'admin' && !DISPLAY_ONLY.has(f.type));
  const adminAnswers: Answers = {};
  for (const f of adminFields) {
    // Event details come from the activity itself when the field is set to (activity.*); an explicit value still wins.
    const fromActivity = f.prefill?.startsWith('activity.') ? activityValues[f.prefill] : undefined;
    const value = incoming[f.id] ?? fromActivity;
    if (value === undefined || value === null || value === '') continue;
    const error = answerFormatError(f, value);
    if (error) return { ok: false, status: 400, body: { error: 'invalid_answer', fieldId: f.id, reason: error } };
    adminAnswers[f.id] = value;
  }
  // A required admin field only has to be filled if it can be visible at all — conditions on admin answers resolve now.
  const visible = visibleIds(t.sections, adminAnswers);
  const missing = adminFields.filter(f => f.required && visible.has(f.id) && !f.showIf && !isAnswered(f, adminAnswers[f.id]));
  if (missing.length) return { ok: false, status: 400, body: { error: 'missing_required', fieldIds: missing.map(f => f.id) } };

  const assignedAt = new Date().toISOString();
  // 'new_members' matches nobody yet — it fills up as members join.
  const rosters = await loadRosters(brand, [{ target }]);
  const trainees = (await listFormPeople(brand, head.settings)).filter(tr => targetIncludes(target, tr, assignedAt, rosters));
  if (target.kind === 'members' && !trainees.length) return { ok: false, status: 400, body: { error: 'no_trainees' } };

  const assignmentId = randomUUID();
  const now = assignedAt;
  const item: FormAssignmentItem = {
    ...formAssignmentKey(templateId, assignmentId), assignmentId, templateId, target, adminAnswers,
    version: head.publishedVersion, createdAt: now, createdBy: uid,
  };
  await ddb.send(new PutCommand({ TableName: formsTable(brand), Item: item, ConditionExpression: 'attribute_not_exists(SK)' }));

  let notified = 0;
  if (input.notify !== false) {
    // Only the side(s) the form actually shows up for (visibleOn).
    const roles = participatingRoles(t);
    const toTrainee = rolesOnDevice('trainee_phone', roles, t.traineeDevice, brand).length > 0;
    const toParent = brand === 'forca' && rolesOnDevice('parent_phone', roles, t.traineeDevice, brand).length > 0;
    const messages: ExpoPushMessage[] = [];
    for (const tr of trainees) {
      for (const who of [toTrainee ? tr.uid : null, toParent ? await parentOf(brand, tr.uid) : null]) {
        if (!who) continue;
        const profile = who === tr.uid ? tr.profile : await getProfile(brand, who);
        const token = profile && getExpoPushToken(profile);
        if (token) messages.push({ to: token, title: 'טופס חדש לחתימה', body: `"${t.name}" ממתין באפליקציה`, data: { type: 'form_to_sign', templateId } });
      }
    }
    notified = messages.length ? await sendExpoPushBatch(messages, 'formAssigned') : 0;
  }

  return { ok: true, assignmentId, trainees: trainees.length, notified };
}
