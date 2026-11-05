import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { getExpoPushToken, sendExpoPush } from '../push';
import {
  assignmentKey, computeSubmissionStatus, getProfile, getTemplateHead, getTemplateVersion, latestByAssignment, listSubmissionsOfTemplate, parentOf, versionToSign,
} from './submissions';
import { writeAudit } from './audit';
import { parseBrand } from './shared';

// POST /adminSendFormReminder
// Body: { templateId, assignmentId, childId, brand }
// Auth: Cognito JWT, admin only. Pushes a reminder to whoever the form is
// still waiting on for this trainee (the parent, the trainee, or both).
// Returns { sent, to: ['parent'|'trainee'] } — sent=0 when nobody on the
// waiting side has push enabled, so the admin knows to follow up another way.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });
  let body: { templateId?: unknown; assignmentId?: unknown; childId?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const templateId = typeof body.templateId === 'string' ? body.templateId : '';
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : '';
  const childId = typeof body.childId === 'string' ? body.childId : '';
  if (!templateId || !assignmentId || !childId) return json(400, { error: 'missing_fields' });

  const brand = parseBrand(body.brand);
  const head = await getTemplateHead(brand, templateId);
  if (!head || !head.publishedVersion) return json(404, { error: 'not_found' });
  const existing = latestByAssignment(await listSubmissionsOfTemplate(brand, templateId), childId).get(assignmentKey(templateId, assignmentId));
  const { version, reuse } = versionToSign(head, existing);
  const t = await getTemplateVersion(brand, templateId, version);
  if (!t) return json(404, { error: 'not_found' });
  const sub = reuse ? existing : undefined;
  const { status, missing } = computeSubmissionStatus({
    signers: t.signers, acknowledgers: t.acknowledgers, resignFromVersion: head.resignFromVersion,
    signedRoles: sub?.signedRoles ?? [], ackRoles: sub?.ackRoles ?? [], version,
  });
  if (status === 'completed') return json(409, { error: 'already_completed' });

  let sent = 0;
  for (const role of missing) {
    // INCORE: the member's own phone for everyone (a parent signs there, switched in).
    const target = role === 'trainee' || brand === 'incore' ? childId : await parentOf(brand, childId);
    const profile = target ? await getProfile(brand, target) : null;
    const token = profile && getExpoPushToken(profile);
    if (!token) continue;
    await sendExpoPush(token, 'תזכורת: טופס מחכה לחתימה', `"${t.name}" עדיין מחכה לחתימה שלך באפליקציה`, { type: 'form_to_sign', templateId });
    sent++;
  }
  await writeAudit(brand, { action: 'remind', templateId, childId, actorUid: uid, detail: { assignmentId, to: missing, sent } });
  return json(200, { success: true, sent, to: missing });
}
