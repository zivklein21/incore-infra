import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import { getUid, json } from '../http';
import { resolveMemberProfile } from '../memberLookup';
import { FamilyCaller, participatingRoles, resolveFamilyCaller, rolesOnDevice } from './familyForms';
import {
  assignmentKey, computeSubmissionStatus, getProfile, getTemplateVersion, latestByAssignment, listAssignments, listSubmissionsOfChild,
  listTemplateHeads, loadRosters, parentOf, SIGNUP_ASSIGNMENT_ID, targetIncludes, versionToSign,
  isCoachProfile, loadActivityItems, activityItemOf,
} from './submissions';
import { activityDetailsHash, fillTextVariables, formAnswersFor, formTextVariablesFor, isFrozen } from './activityFields';
import { isCoachForm } from './schema';
import { prefillValues } from './prefill';
import { evaluateOutcome } from './logic';
import { orphanedSignedForms, parentPendingCount, withParentSections } from './parentForms';

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
// already completed stays listed (read-only, with its PDF) — on BOTH devices,
// even one that had no part in it (the child's profile shows every final
// signed form about her).
//
// Each form says its kind: 'signup' forms are the first-login ones (also
// reported by getProfile so the app routes there before the home screen);
// 'activity' forms carry the calendar activity they belong to (name + date).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (event.queryStringParameters?.scope === 'family') return json(200, await familyForms(uid));
  const caller = await resolveFamilyCaller(uid, event.queryStringParameters?.childId || undefined);
  if (!caller) return json(403, { error: 'forbidden' });
  const rows = await formsForCaller(caller);
  if (!rows) return json(404, { error: 'member_not_found' });
  if (caller.device !== 'parent_phone') return json(200, { forms: rows, pendingCount: rows.filter(f => f.myRoles.length > 0).length });
  const forms = withParentSections(rows);
  return json(200, { forms, pendingCount: parentPendingCount(forms) });
}

/**
 * ?scope=family — every linked child's forms in one call, for the parent's
 * forms card. Children come from the caller's own FAMILY# links and each one
 * still goes through resolveFamilyCaller's link check, so nothing here can
 * reach a child who isn't theirs.
 */
async function familyForms(uid: string) {
  const self = await resolveMemberProfile(uid);
  if (!self) return { children: [], pendingCount: 0 };
  const links = await ddb.send(new QueryCommand({
    TableName: self.table,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'FAMILY#' },
  }));
  const children = [];
  for (const link of links.Items ?? []) {
    const childId = String(link.childUid ?? String(link.SK).replace(/^FAMILY#/, ''));
    const caller = await resolveFamilyCaller(uid, childId);
    const rows = caller ? await formsForCaller(caller) : null;
    if (!rows) continue;
    const forms = withParentSections(rows);
    children.push({ childId, forms, pendingCount: parentPendingCount(forms) });
  }
  return { children, pendingCount: children.reduce((sum, c) => sum + c.pendingCount, 0) };
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

  const [rosters, activityItems] = await Promise.all([loadRosters(caller.brand, assignments), loadActivityItems(caller.brand, assignments)]);
  // Coach forms are only for coaches, and coaches get nothing else (see TemplateSettings.audience).
  const callerIsCoach = isCoachProfile(child);
  const forms: MyFormRow[] = [];
  for (const a of assignments) {
    const head = headById.get(a.templateId);
    if (!head || isCoachForm(head.settings) !== callerIsCoach || !targetIncludes(a.target, trainee, a.createdAt, rosters)) continue;
    // A sign-up form's own assignment only counts while the form IS a sign-up form.
    if (a.assignmentId === SIGNUP_ASSIGNMENT_ID && head.settings.kind !== 'signup') continue;
    const existing = latest.get(assignmentKey(a.templateId, a.assignmentId));
    const { version, reuse } = versionToSign(head, existing);
    const t = await getTemplateVersion(caller.brand, a.templateId, version);
    if (!t) continue;
    const sub = reuse ? existing : undefined;
    const deviceRoles = rolesOnDevice(caller.device, participatingRoles(t), t.traineeDevice, caller.brand);

    const signedRoles = sub?.signedRoles ?? [];
    const ackRoles = sub?.ackRoles ?? [];
    const { status, missing } = computeSubmissionStatus({
      signers: t.signers, acknowledgers: t.acknowledgers, resignFromVersion: head.resignFromVersion, signedRoles, ackRoles, version,
    });
    // A form with no part on this device is listed only once it's COMPLETED — so the child sees, read-only,
    // every final signed form about her (e.g. one only her parent signs on the parent's phone).
    if (!deviceRoles.length && status !== 'completed') continue;
    // Fill-only roles (fields but no signature) also have a turn, before acknowledgers.
    const fillOnly = deviceRoles.filter(r => !t.signers.includes(r) && !t.acknowledgers.includes(r) && !signedRoles.includes(r));
    const myRoles = status === 'completed' ? [] : [...fillOnly, ...missing.filter(r => deviceRoles.includes(r))];
    const waiting = missing.filter(r => !deviceRoles.includes(r));
    // Activity-linked details are the activity's CURRENT ones until someone signs (activityFields.ts).
    const cls = activityItemOf(activityItems, a.target);
    const answers = formAnswersFor({ sections: t.sections, assignmentAdminAnswers: a.adminAnswers, cls, sub });
    const activityVars = formTextVariablesFor({ sections: t.sections, cls, sub });

    forms.push({
      templateId: a.templateId,
      assignmentId: a.assignmentId,
      submissionId: sub?.submissionId ?? null,
      title: t.name,
      code: t.settings.code,
      description: t.settings.description,
      required: t.settings.required,
      numberQuestions: t.settings.numberQuestions === true,
      audience: isCoachForm(head.settings) ? 'coaches' : 'members',
      beforeFirstTraining: t.settings.beforeFirstTraining || a.assignmentId === SIGNUP_ASSIGNMENT_ID,
      kind: a.assignmentId === SIGNUP_ASSIGNMENT_ID ? 'signup' : 'activity',
      activity: a.target.kind === 'activity'
        ? { name: (typeof cls?.className === 'string' ? cls.className : '') || (a.target.className ?? ''), date: (typeof cls?.date === 'string' ? cls.date : '') || a.target.date }
        : null,
      // Sent back with submitFormPart, so nobody signs activity details that changed while the form was open.
      activityDetailsHash: cls && !isFrozen(sub) ? activityDetailsHash(t.sections, answers, activityVars) : null,
      // {activity.*} variables in the text → values (null: none, or not attached to an activity — shown as the variable).
      activityVars,
      version,
      signers: t.signers,
      acknowledgers: t.acknowledgers,
      traineeDevice: t.traineeDevice,
      // Text with its {activity.*} variables filled in (the app in the stores shows values too); unknown ones stay, highlighted by the app.
      sections: fillTextVariables(t.sections, activityVars),
      status,
      deviceRoles,
      myRoles,
      waiting,
      signedRoles,
      ackRoles,
      answers,
      answeredBy: sub?.answeredBy ?? {},
      signatures: (sub?.signatures ?? []).map(s => ({ fieldId: s.fieldId, role: s.role, name: s.name, paths: s.paths, signedAt: s.signedAt })),
      prefill,
      completedAt: sub?.completedAt ?? null,
      // Result + where the final form shows: the CURRENT settings (head), so edited texts apply to everyone at once.
      showIn: head.settings.showIn,
      outcome: status === 'completed' && sub ? evaluateOutcome(head.settings.outcome, t.sections, sub.answers) : null,
      hasPdf: !!sub?.pdfS3Key,
      assignedAt: a.createdAt,
    });
  }

  // A signature is never lost from view: a version that was re-signed past,
  // or a form whose assignment ended (cancelled, archived, no longer a
  // sign-up form, moved group) has no row above but stays listed as signed.
  for (const { sub, previousVersion } of orphanedSignedForms(subs, caller.childId, forms)) {
    const t = await getTemplateVersion(caller.brand, sub.templateId, sub.version);
    if (!t || isCoachForm(t.settings) !== callerIsCoach) continue;
    const head = heads.find(h => h.id === sub.templateId);
    const settings = head?.settings ?? t.settings;
    forms.push({
      templateId: sub.templateId,
      assignmentId: sub.assignmentId,
      submissionId: sub.submissionId,
      title: t.name,
      code: t.settings.code,
      description: t.settings.description,
      required: t.settings.required,
      numberQuestions: t.settings.numberQuestions === true,
      audience: isCoachForm(t.settings) ? 'coaches' : 'members',
      beforeFirstTraining: false,
      kind: sub.assignmentId === SIGNUP_ASSIGNMENT_ID ? 'signup' : 'activity',
      activity: null,
      version: sub.version,
      previousVersion,
      signers: t.signers,
      acknowledgers: t.acknowledgers,
      traineeDevice: t.traineeDevice,
      sections: fillTextVariables(t.sections, sub.activityVars ?? null),
      status: 'completed',
      deviceRoles: [],
      myRoles: [],
      waiting: [],
      signedRoles: sub.signedRoles,
      ackRoles: sub.ackRoles,
      answers: sub.answers,
      activityVars: sub.activityVars ?? null,
      answeredBy: sub.answeredBy,
      signatures: sub.signatures.map(s => ({ fieldId: s.fieldId, role: s.role, name: s.name, paths: s.paths, signedAt: s.signedAt })),
      prefill,
      completedAt: sub.completedAt ?? null,
      showIn: settings.showIn,
      // A replaced version's result no longer applies — the current one decides.
      outcome: previousVersion ? null : evaluateOutcome(settings.outcome, t.sections, sub.answers),
      hasPdf: !!sub.pdfS3Key,
      assignedAt: sub.createdAt,
    });
  }

  // Sign-up / before-first-training first, then forms waiting on this device (soonest activity first), then the rest.
  const rank = (f: MyFormRow) => (f.status === 'completed' ? 3 : f.myRoles.length ? (f.beforeFirstTraining ? 0 : 1) : 2);
  const when = (f: MyFormRow) => f.activity?.date ?? '9999';
  forms.sort((x, y) => rank(x) - rank(y) || when(x).localeCompare(when(y)) || y.assignedAt.localeCompare(x.assignedAt));
  return forms;
}
