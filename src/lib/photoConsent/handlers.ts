import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { getExpoPushToken, sendExpoPush } from '../push';
import { writeAudit } from '../formTemplates/audit';
import { resolveFamilyCaller, type FamilyCaller } from '../formTemplates/familyForms';
import { presignPdf } from '../formTemplates/signedPdf';
import { getProfile, isCoachProfile, parentOf } from '../formTemplates/submissions';
import { consentStatus, otherSide, signatureError, type ConsentDecision, type ConsentRole, type ConsentStatus } from './shared';
import { ConsentConflict, consentHistory, ensureConsentPdf, loadConsent, recordConsentChange } from './store';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

/** A parent for their own linked child, or a trainee for herself — FORCA members only. */
async function consentCaller(uid: string, childId: string | undefined): Promise<(FamilyCaller & { role: ConsentRole }) | null> {
  const caller = await resolveFamilyCaller(uid, childId);
  if (!caller || caller.brand !== 'forca') return null;
  const child = await getProfile('forca', caller.childId);
  if (!child || isCoachProfile(child)) return null;
  return { ...caller, role: caller.device === 'parent_phone' ? 'parent' : 'trainee' };
}

// GET /getPhotoConsent?childId=
export async function getPhotoConsent(event: Event): Promise<Result> {
  const caller = await consentCaller(getUid(event), event.queryStringParameters?.childId || undefined);
  if (!caller) return json(403, { error: 'forbidden' });
  const [{ state }, history] = await Promise.all([loadConsent(caller.childId), consentHistory(caller.childId)]);
  return json(200, {
    status: consentStatus(state),
    parent: state.parent,
    trainee: state.trainee,
    myRole: caller.role,
    history: history.map(h => ({ id: h.id, role: h.role, decision: h.decision, name: h.name, signedAt: h.signedAt })),
  });
}

/** Tells the other side what changed — it's also on their forms page. Best effort, never fails the change. */
async function notifyOtherSide(caller: FamilyCaller & { role: ConsentRole }, status: ConsentStatus): Promise<void> {
  try {
    const uid = otherSide(caller.role) === 'trainee' ? caller.childId : await parentOf('forca', caller.childId);
    const profile = uid ? await getProfile('forca', uid) : null;
    const token = profile && getExpoPushToken(profile);
    if (!token) return;
    const body = status === 'pending' ? 'יש בקשה לאישור הסכמה לצילום ופרסום. נכנסים לטפסים כדי לאשר.'
      : status === 'approved' ? 'ההסכמה לצילום ופרסום אושרה על ידי שני הצדדים.'
        : 'ההסכמה לצילום ופרסום בוטלה.';
    await sendExpoPush(token, 'הסכמה לצילום ופרסום', body, { type: 'photo_consent', childId: caller.childId });
  } catch (err) {
    console.warn('[photoConsent] notify failed', err);
  }
}

// POST /changePhotoConsent
// Body: { childId?, decision: 'agree' | 'refuse', typedName, paths }
// The signing time is the server's; the only device detail kept is which side's.
export async function changePhotoConsent(event: Event): Promise<Result> {
  const uid = getUid(event);
  let body: { childId?: unknown; decision?: unknown; typedName?: unknown; paths?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const decision = body.decision === 'agree' || body.decision === 'refuse' ? body.decision as ConsentDecision : null;
  if (!decision) return json(400, { error: 'invalid_decision' });
  const invalid = signatureError(body.typedName, body.paths);
  if (invalid) return json(400, { error: invalid });

  const caller = await consentCaller(uid, typeof body.childId === 'string' && body.childId ? body.childId : undefined);
  if (!caller) return json(403, { error: 'forbidden' });

  const { state: current } = await loadConsent(caller.childId);
  if (current[caller.role] === decision) return json(409, { error: 'no_change' });

  let change;
  try {
    change = await recordConsentChange({
      childId: caller.childId, role: caller.role, decision, userId: uid,
      name: (body.typedName as string).trim().slice(0, 120), paths: body.paths as string[], device: caller.device,
    });
  } catch (err) {
    if (err instanceof ConsentConflict) return json(409, { error: 'conflict' });
    throw err;
  }

  await writeAudit('forca', {
    action: 'sign', templateId: 'photo_consent', submissionId: change.log.id, childId: caller.childId, actorUid: uid,
    detail: { role: caller.role, decision, status: change.status, device: caller.device },
  });
  try {
    await ensureConsentPdf(change.log);
  } catch (err) {
    // The change already stands; the PDF is generated on its first download.
    console.error('[photoConsent] PDF generation failed', change.log.id, err);
  }
  await notifyOtherSide(caller, change.status);

  return json(200, { success: true, status: change.status, parent: change.state.parent, trainee: change.state.trainee, signedAt: change.log.signedAt });
}

// GET /getPhotoConsentPdfUrl?childId=&id=
export async function getPhotoConsentPdfUrl(event: Event): Promise<Result> {
  const caller = await consentCaller(getUid(event), event.queryStringParameters?.childId || undefined);
  if (!caller) return json(403, { error: 'forbidden' });
  const id = event.queryStringParameters?.id ?? '';
  const log = (await consentHistory(caller.childId)).find(h => h.id === id);
  if (!log) return json(404, { error: 'not_found' });
  const key = await ensureConsentPdf(log);
  return json(200, { url: await presignPdf('forca', key, `photo-consent-${id}.pdf`) });
}
