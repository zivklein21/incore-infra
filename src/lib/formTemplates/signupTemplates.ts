import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import type { SignupFlowStep } from '../signupFlow/shared';
import { isCoachForm, type FormKind } from './schema';
import { formAssignmentKey, formTemplateKey } from './shared';
import { formsTable, listAssignments, listTemplateHeads, SIGNUP_ASSIGNMENT_ID, type Brand } from './submissions';
import { writeAudit } from './audit';

// Custom templates in the First Sign-up Order. A template step's `included`
// is NOT stored truth: what really decides whether members get a form is the
// template's settings.kind plus its 'signup' assignment (getMyForms.ts), so
// the admin page's toggle reads and writes those. One mechanism, shared with
// the template editor's Sign-up / Activity chips.
//
// The assignment targets 'new_members', so switching a form on only reaches
// accounts created from that moment on. Nobody who already has an account is
// ever asked because of this toggle (the forms HARD RULE).

interface TemplateState {
  id: string;
  status: string;
  publishedVersion: number;
  settings: { kind?: FormKind; audience?: string };
}

const templateStepId = (id: string) => `template:${id}`;

/** Only a live, member-facing form can join sign-up — a draft has nothing to sign, and coach forms are never part of it. */
export function canJoinSignup(t: TemplateState): boolean {
  return t.status === 'published' && t.publishedVersion > 0 && !isCoachForm(t.settings);
}

const isSignupNow = (t: TemplateState) => canJoinSignup(t) && t.settings.kind === 'signup';

/** The saved order with each template's real state; templates not in the order yet go after the listed steps. */
export function withTemplateState(steps: SignupFlowStep[], templates: TemplateState[]): SignupFlowStep[] {
  const byStep = new Map(templates.map(t => [templateStepId(t.id), t]));
  const known = new Set(steps.map(s => s.formId));
  return [
    ...steps
      .filter(s => !s.formId.startsWith('template:') || byStep.has(s.formId))
      .map(s => {
        const t = byStep.get(s.formId);
        return t ? { ...s, included: isSignupNow(t) } : s;
      }),
    ...templates
      .filter(t => !known.has(templateStepId(t.id)))
      .map(t => ({ formId: templateStepId(t.id), included: isSignupNow(t) })),
  ];
}

/** When each live sign-up form was switched on: it reaches only accounts created after this. templateId → ISO time. */
export async function signupCutoffs(brand: Brand): Promise<Record<string, string>> {
  const assignments = await listAssignments(brand);
  return Object.fromEntries(assignments.filter(a => a.assignmentId === SIGNUP_ASSIGNMENT_ID).map(a => [a.templateId, a.createdAt]));
}

/** Pending sign-up forms in the admin's order; a form the order doesn't list goes last, keeping its place among those. */
export function sortBySignupOrder<T extends { templateId: string }>(forms: T[], steps: SignupFlowStep[]): T[] {
  const rank = new Map(steps.map((s, i) => [s.formId, i]));
  const at = (f: T) => rank.get(templateStepId(f.templateId)) ?? Number.MAX_SAFE_INTEGER;
  return forms.map((f, i) => ({ f, i })).sort((a, b) => at(a.f) - at(b.f) || a.i - b.i).map(x => x.f);
}

/** Which templates need their kind changed for these toggles — a form that can't join is left exactly as it is. */
export function signupChanges<T extends TemplateState>(steps: SignupFlowStep[], templates: T[]): { template: T; signup: boolean; kindChanged: boolean }[] {
  const wanted = new Map(steps.map(s => [s.formId, s.included]));
  return templates.flatMap(t => {
    const signup = wanted.get(templateStepId(t.id));
    if (signup === undefined || !canJoinSignup(t)) return [];
    return [{ template: t, signup, kindChanged: (t.settings.kind === 'signup') !== signup }];
  });
}

/**
 * Brings a template's 'signup' assignment in line. An assignment that's
 * already active is left alone, so its new-members cutoff never moves;
 * cancelling keeps every signature; switching back on starts from that moment.
 */
export async function syncSignupAssignment(table: string, templateId: string, isSignup: boolean, uid: string): Promise<void> {
  const key = formAssignmentKey(templateId, SIGNUP_ASSIGNMENT_ID);
  const existing = (await ddb.send(new GetCommand({ TableName: table, Key: key }))).Item;
  const active = !!existing && !existing.cancelledAt;
  if (isSignup && !active) {
    await ddb.send(new PutCommand({
      TableName: table,
      Item: {
        ...key, assignmentId: SIGNUP_ASSIGNMENT_ID, templateId, target: { kind: 'new_members' }, adminAnswers: {},
        version: 0, createdAt: new Date().toISOString(), createdBy: uid,
      },
    }));
  } else if (!isSignup && active) {
    await ddb.send(new UpdateCommand({
      TableName: table, Key: key,
      UpdateExpression: 'SET cancelledAt = :now, cancelledBy = :uid',
      ExpressionAttributeValues: { ':now': new Date().toISOString(), ':uid': uid },
    }));
  }
}

/** Applies the page's toggles. Settings aren't content, so this never makes a new version or asks anyone to re-sign. */
export async function applySignupToggles(brand: Brand, steps: SignupFlowStep[], uid: string): Promise<void> {
  const table = tableForBrand(brand);
  for (const { template, signup, kindChanged } of signupChanges(steps, await listTemplateHeads(brand))) {
    if (kindChanged) {
      await ddb.send(new UpdateCommand({
        TableName: formsTable(brand),
        Key: formTemplateKey(template.id),
        UpdateExpression: 'SET settings = :settings, updatedAt = :now',
        ExpressionAttributeValues: {
          ':settings': { ...template.settings, kind: signup ? 'signup' : 'activity', beforeFirstTraining: signup || template.settings.beforeFirstTraining },
          ':now': new Date().toISOString(),
        },
      }));
    }
    await syncSignupAssignment(table, template.id, signup, uid);
    if (kindChanged) await writeAudit(brand, { action: signup ? 'assign' : 'unassign', templateId: template.id, actorUid: uid, detail: { assignmentId: SIGNUP_ASSIGNMENT_ID, via: 'first_signup_order' } });
  }
}
