import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { verifyFamilyLink } from '../familyLinks';
import { getExpoPushToken, sendExpoPush } from '../push';
import { DISPLAY_ONLY, SIGNER_ROLES, SignerRole, TraineeDevice } from './schema';
import { getProfile, parentOf, type FormSubmissionItem } from './submissions';
import type { StoredTemplate } from './shared';

// Who is calling a family forms endpoint, and on which device. A FORCA
// parent uses her own (parent_only) account and passes the child's id —
// verified against the FAMILY# link exactly like the other Child Switcher
// endpoints (getChildProfile.ts etc.); a trainee calls with no childId
// (her own). The device decides which signers' parts may be done here
// (rolesOnDevice), mirroring the app's formTemplateLogic.rolesOnDevice.

export type Device = 'parent_phone' | 'trainee_phone';

export interface FamilyCaller { uid: string; childId: string; device: Device }

export async function resolveFamilyCaller(uid: string, childId: string | undefined): Promise<FamilyCaller | null> {
  if (childId && childId !== uid) {
    const link = await verifyFamilyLink(uid, childId);
    return link.ok ? { uid, childId, device: 'parent_phone' } : null;
  }
  const self = await getProfile(uid);
  if (!self || self.identity?.accountType === 'parent_only') return null;
  return { uid, childId: uid, device: 'trainee_phone' };
}

/**
 * Roles whose part can be done on `device`. The parent always signs on the
 * parent's phone; the trainee per the form's visibleOn (traineeDevice):
 * parent's phone only, her own phone only, or either. Every FORCA trainee
 * has her own login (adminCreateUser.ts creates one), so there's no
 * no-account fallback to apply here.
 */
export function rolesOnDevice(device: Device, roles: SignerRole[], traineeDevice: TraineeDevice): SignerRole[] {
  return roles.filter(role => {
    if (role === 'parent') return device === 'parent_phone';
    if (device === 'parent_phone') return traineeDevice === 'parent_phone' || traineeDevice === 'either';
    return traineeDevice === 'own_phone' || traineeDevice === 'either';
  });
}

/** Every signer-side role that signs, confirms or fills anything in this version, in turn order (acknowledgers last). */
export function participatingRoles(t: StoredTemplate): SignerRole[] {
  const used = new Set<SignerRole>([...t.signers, ...t.acknowledgers]);
  for (const s of t.sections) for (const f of s.fields) {
    if (!DISPLAY_ONLY.has(f.type) && (f.filledBy === 'parent' || f.filledBy === 'trainee')) used.add(f.filledBy);
  }
  const doers = SIGNER_ROLES.filter(r => used.has(r) && !t.acknowledgers.includes(r));
  return [...doers, ...SIGNER_ROLES.filter(r => t.acknowledgers.includes(r))];
}

export const requestMeta = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => ({
  ip: event.requestContext.http?.sourceIp ?? '',
  userAgent: (event.headers?.['user-agent'] ?? event.requestContext.http?.userAgent ?? '').slice(0, 400),
});

/** Nudges whoever's turn it is now (best effort, never throws). */
export async function notifyNextSigner(sub: FormSubmissionItem, missing: SignerRole[], title: string): Promise<void> {
  try {
    const targets: string[] = [];
    if (missing.includes('trainee')) targets.push(sub.childId);
    if (missing.includes('parent')) {
      const parent = await parentOf(sub.childId);
      if (parent) targets.push(parent);
    }
    for (const uid of targets) {
      const profile = await getProfile(uid);
      const token = profile && getExpoPushToken(profile);
      if (token) await sendExpoPush(token, 'טופס מחכה לחתימה', `"${title}" מחכה לחתימה שלך באפליקציה`, { type: 'form_to_sign', templateId: sub.templateId });
    }
  } catch (err) {
    console.warn('[familyForms] notify failed', err);
  }
}
