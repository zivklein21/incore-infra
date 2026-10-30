import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ddb } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { getExpoPushToken, sendExpoPushBatch, type ExpoPushMessage } from '../push';
import { formAssignmentKey, parseBrand } from './shared';
import { DISPLAY_ONLY } from './schema';
import { Answers, answerFormatError, FieldAnswer, isAnswered, visibleIds } from './logic';
import {
  AssignmentTarget, FormAssignmentItem, formsTable, getTemplateHead, getTemplateVersion, listTrainees, parentOf, getProfile, targetIncludes,
} from './submissions';
import { writeAudit } from './audit';
import { participatingRoles, rolesOnDevice } from './familyForms';

// POST /adminAssignFormTemplate
// Body (assign):  { templateId, target: { kind: 'all' } | { kind: 'new_members' } | { kind: 'group', groupId, groupName? }
//                   | { kind: 'members', memberIds }, adminAnswers?: { [adminFieldId]: value }, notify?: boolean, brand }
// Body (cancel):  { action: 'cancel', templateId, assignmentId, brand }
// Auth: Cognito JWT, admin only. Either brand. INCORE's usual target is
// 'new_members' — only members who join after the assignment see it, so no
// existing member is ever asked (groups are FORCA-only).
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
    await writeAudit(brand, { action: 'unassign', templateId, actorUid: uid, detail: { assignmentId } });
    return json(200, { success: true });
  }

  const head = await getTemplateHead(brand, templateId);
  if (!head) return json(404, { error: 'not_found' });
  if (head.status !== 'published' || !head.publishedVersion) return json(409, { error: 'not_published' });
  const t = await getTemplateVersion(brand, templateId, head.publishedVersion);
  if (!t) return json(404, { error: 'not_found' });

  const raw = (body.target ?? {}) as Record<string, unknown>;
  let target: AssignmentTarget;
  if (raw.kind === 'all') target = { kind: 'all' };
  else if (raw.kind === 'new_members') target = { kind: 'new_members' };
  else if (brand === 'forca' && raw.kind === 'group' && typeof raw.groupId === 'string' && raw.groupId) {
    target = { kind: 'group', groupId: raw.groupId, ...(typeof raw.groupName === 'string' ? { groupName: raw.groupName } : {}) };
  } else if (raw.kind === 'members' && Array.isArray(raw.memberIds) && raw.memberIds.length) {
    target = { kind: 'members', memberIds: [...new Set(raw.memberIds.filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 500) };
  } else return json(400, { error: 'invalid_target' });

  // Admin-filled fields: values for exactly those, validated like family answers.
  const incoming = (body.adminAnswers && typeof body.adminAnswers === 'object' ? body.adminAnswers : {}) as Record<string, FieldAnswer>;
  const adminFields = t.sections.flatMap(s => s.fields).filter(f => f.filledBy === 'admin' && !DISPLAY_ONLY.has(f.type));
  const adminAnswers: Answers = {};
  for (const f of adminFields) {
    const value = incoming[f.id];
    if (value === undefined || value === null || value === '') continue;
    const error = answerFormatError(f, value);
    if (error) return json(400, { error: 'invalid_answer', fieldId: f.id, reason: error });
    adminAnswers[f.id] = value;
  }
  // A required admin field only has to be filled if it can be visible at all — conditions on admin answers resolve now.
  const visible = visibleIds(t.sections, adminAnswers);
  const missing = adminFields.filter(f => f.required && visible.has(f.id) && !f.showIf && !isAnswered(f, adminAnswers[f.id]));
  if (missing.length) return json(400, { error: 'missing_required', fieldIds: missing.map(f => f.id) });

  const assignedAt = new Date().toISOString();
  // 'new_members' matches nobody yet — it fills up as members join.
  const trainees = (await listTrainees(brand)).filter(tr => targetIncludes(target, tr, assignedAt));
  if (target.kind === 'members' && !trainees.length) return json(400, { error: 'no_trainees' });

  const assignmentId = randomUUID();
  const now = assignedAt;
  const item: FormAssignmentItem = {
    ...formAssignmentKey(templateId, assignmentId), assignmentId, templateId, target, adminAnswers,
    version: head.publishedVersion, createdAt: now, createdBy: uid,
  };
  await ddb.send(new PutCommand({ TableName: formsTable(brand), Item: item, ConditionExpression: 'attribute_not_exists(SK)' }));
  await writeAudit(brand, { action: 'assign', templateId, actorUid: uid, detail: { assignmentId, target, trainees: trainees.length } });

  let notified = 0;
  if (body.notify !== false) {
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

  return json(200, { success: true, assignmentId, trainees: trainees.length, notified });
}
