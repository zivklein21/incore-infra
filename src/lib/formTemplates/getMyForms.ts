import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { FamilyCaller, participatingRoles, resolveFamilyCaller, rolesOnDevice } from './familyForms';
import {
  computeSubmissionStatus, getProfile, getTemplateVersion, latestByAssignment, listAssignments, listSubmissionsOfChild,
  listTemplateHeads, loadRosters, parentOf, SIGNUP_ASSIGNMENT_ID, targetIncludes, versionToSign,
} from './submissions';
import { prefillValues } from './prefill';

// GET /getMyForms?childId=<uid>
// Auth: Cognito JWT, either brand (the caller's profile table decides). A
// parent passes her linked child's id (parent's phone); a trainee / INCORE
// member passes nothing (her own phone). INCORE forms are typically assigned
// to new members only (target 'new_members'). Returns the "Forms to
// sign" list for THIS device: every published form assigned to the child
// whose part can be done here (visibleOn), with
//
//   status   pending_parent / pending_child / completed
//   myRoles  roles whose turn it is on this device right now (badge count =
//            forms with myRoles non-empty); acknowledgers only once every
//            signer signed
//   waiting  roles still missing that sign elsewhere ("Waiting for …")
//
// plus the signed version's content, the answers so far (other side's are
// read-only), signatures already made (with server time), admin-filled
// answers and profile prefill. Archived forms are hidden; a form a family
// already completed stays listed (read-only, PDF for the parent).
//
// Each form says its kind: 'signup' forms are the first-login ones (also
// reported by getProfile so the app routes there before the home screen);
// 'activity' forms carry the calendar activity they belong to (name + date).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  const caller = await resolveFamilyCaller(uid, event.queryStringParameters?.childId || undefined);
  if (!caller) return json(403, { error: 'forbidden' });
  const forms = await formsForCaller(caller);
  if (!forms) return json(404, { error: 'member_not_found' });
  return json(200, { forms, pendingCount: forms.filter(f => f.myRoles.length > 0).length });
}

export type MyFormRow = {
  templateId: string; assignmentId: string; title: string; status: string; myRoles: string[]; waiting: string[];
  kind: 'signup' | 'activity'; beforeFirstTraining: boolean; assignedAt: string; activity: { name: string; date: string } | null;
} & Record<string, unknown>;

/** The "Forms to sign" list for one caller (device + child) — shared with profileResponse.ts's first-login gate. */
export async function formsForCaller(caller: FamilyCaller): Promise<MyFormRow[] | null> {
  const [heads, assignments, subs, child] = await Promise.all([
    listTemplateHeads(caller.brand), listAssignments(caller.brand), listSubmissionsOfChild(caller.brand, caller.childId), getProfile(caller.brand, caller.childId),
  ]);
  if (!child) return null;
  const trainee = { uid: caller.childId, groupId: child.identity?.groupId, createdAt: (child as { createdAt?: string }).createdAt };
  const headById = new Map(heads.filter(h => h.status === 'published' && h.publishedVersion > 0).map(h => [h.id, h]));
  const latest = latestByAssignment(subs, caller.childId);

  const parentUid = caller.device === 'parent_phone' ? caller.uid : await parentOf(caller.brand, caller.childId);
  const parent = parentUid ? await getProfile(caller.brand, parentUid) : null;
  const prefill = prefillValues(child as never, parent as never);

  const rosters = await loadRosters(caller.brand, assignments);
  const forms: MyFormRow[] = [];
  for (const a of assignments) {
    const head = headById.get(a.templateId);
    if (!head || !targetIncludes(a.target, trainee, a.createdAt, rosters)) continue;
    // A sign-up form's own assignment only counts while the form IS a sign-up form.
    if (a.assignmentId === SIGNUP_ASSIGNMENT_ID && head.settings.kind !== 'signup') continue;
    const existing = latest.get(a.assignmentId);
    const { version, reuse } = versionToSign(head, existing);
    const t = await getTemplateVersion(caller.brand, a.templateId, version);
    if (!t) continue;
    const sub = reuse ? existing : undefined;
    const deviceRoles = rolesOnDevice(caller.device, participatingRoles(t), t.traineeDevice, caller.brand);
    if (!deviceRoles.length) continue;

    const signedRoles = sub?.signedRoles ?? [];
    const ackRoles = sub?.ackRoles ?? [];
    const { status, missing } = computeSubmissionStatus({
      signers: t.signers, acknowledgers: t.acknowledgers, resignFromVersion: head.resignFromVersion, signedRoles, ackRoles, version,
    });
    // Fill-only roles (fields but no signature) also have a turn, before acknowledgers.
    const fillOnly = deviceRoles.filter(r => !t.signers.includes(r) && !t.acknowledgers.includes(r) && !signedRoles.includes(r));
    const myRoles = status === 'completed' ? [] : [...fillOnly, ...missing.filter(r => deviceRoles.includes(r))];
    const waiting = missing.filter(r => !deviceRoles.includes(r));

    forms.push({
      templateId: a.templateId,
      assignmentId: a.assignmentId,
      submissionId: sub?.submissionId ?? null,
      title: t.name,
      code: t.settings.code,
      description: t.settings.description,
      required: t.settings.required,
      beforeFirstTraining: t.settings.beforeFirstTraining || a.assignmentId === SIGNUP_ASSIGNMENT_ID,
      kind: a.assignmentId === SIGNUP_ASSIGNMENT_ID ? 'signup' : 'activity',
      activity: a.target.kind === 'activity' ? { name: a.target.className ?? '', date: a.target.date } : null,
      version,
      signers: t.signers,
      acknowledgers: t.acknowledgers,
      traineeDevice: t.traineeDevice,
      sections: t.sections,
      status,
      deviceRoles,
      myRoles,
      waiting,
      signedRoles,
      ackRoles,
      answers: { ...(sub?.answers ?? {}), ...a.adminAnswers },
      answeredBy: sub?.answeredBy ?? {},
      signatures: (sub?.signatures ?? []).map(s => ({ fieldId: s.fieldId, role: s.role, name: s.name, paths: s.paths, signedAt: s.signedAt })),
      prefill,
      completedAt: sub?.completedAt ?? null,
      hasPdf: !!sub?.pdfS3Key,
      assignedAt: a.createdAt,
    });
  }

  // Sign-up / before-first-training first, then forms waiting on this device (soonest activity first), then the rest.
  const rank = (f: MyFormRow) => (f.status === 'completed' ? 3 : f.myRoles.length ? (f.beforeFirstTraining ? 0 : 1) : 2);
  const when = (f: MyFormRow) => f.activity?.date ?? '9999';
  forms.sort((x, y) => rank(x) - rank(y) || when(x).localeCompare(when(y)) || y.assignedAt.localeCompare(x.assignedAt));
  return forms;
}
