import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import type { ComplianceFlags } from '../entities';

// First Sign-up Order (Manage → Forms → First Sign-up Order): which
// onboarding forms a brand's new members go through, and in what order.
// PK='APPCONFIG' SK='SIGNUP_FLOW_CONFIG' in the brand's own table — same
// one-item-per-config convention as REGISTRATION_FORM_CONFIG.
//
// Only ORDERS and EXCLUDES — a member is still only asked for a form she's
// actually required to fill (admin.require_* / forms.* via
// computeComplianceFlags). An excluded form simply never gates anyone.
// Custom templates are stored as 'template:<id>' steps but aren't fillable
// by members yet, so they never gate either.

export type Brand = 'incore' | 'forca';

export const BUILT_IN_SIGNUP_FORMS = ['registration', 'health', 'orthopedic', 'parental_authorization', 'policies'] as const;
export type SignupFormId = typeof BUILT_IN_SIGNUP_FORMS[number];

export interface SignupFlowStep {
  /** A built-in SignupFormId, or 'template:<id>' for a custom form template. */
  formId: string;
  included: boolean;
}

// Today's hardcoded order, per brand (resolvePostLoginRoute.ts + each form
// screen's own chaining) — the default until an admin saves her own, so
// nothing changes for anyone on deploy. FORCA's is the parent-filled chain
// (Parental Authorization → Health → Orthopedic) followed by the trainee's
// own (Policies → Registration). Orthopedic / Parental Authorization are
// FORCA-only forms, so INCORE doesn't list them.
export const DEFAULT_SIGNUP_ORDER: Record<Brand, SignupFormId[]> = {
  incore: ['registration', 'health', 'policies'],
  forca: ['parental_authorization', 'health', 'orthopedic', 'policies', 'registration'],
};

const isBuiltIn = (id: string): id is SignupFormId => (BUILT_IN_SIGNUP_FORMS as readonly string[]).includes(id);

export const signupFlowKey = { PK: 'APPCONFIG', SK: 'SIGNUP_FLOW_CONFIG' };

/** Saved steps merged with the brand's defaults — any of the brand's built-in forms missing from the saved config is appended, included. */
export function normalizeSteps(brand: Brand, saved: unknown): SignupFlowStep[] {
  const brandForms = DEFAULT_SIGNUP_ORDER[brand];
  const steps: SignupFlowStep[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saved)) {
    for (const raw of saved) {
      const formId = typeof raw?.formId === 'string' ? raw.formId : '';
      const valid = isBuiltIn(formId) ? brandForms.includes(formId) : formId.startsWith('template:') && formId.length > 'template:'.length;
      if (!valid || seen.has(formId)) continue;
      seen.add(formId);
      steps.push({ formId, included: raw.included !== false });
    }
  }
  for (const formId of brandForms) {
    if (!seen.has(formId)) steps.push({ formId, included: true });
  }
  return steps;
}

export async function loadSignupFlow(brand: Brand): Promise<SignupFlowStep[]> {
  const res = await ddb.send(new GetCommand({ TableName: tableForBrand(brand), Key: signupFlowKey }));
  return normalizeSteps(brand, res.Item?.steps);
}

const FLAG_FOR: Record<SignupFormId, keyof ComplianceFlags> = {
  registration: 'requiresRegistrationForm',
  health: 'requiresHealthDeclaration',
  orthopedic: 'requiresOrthopedicForm',
  parental_authorization: 'requiresParentalAuthorization',
  policies: 'requiresPoliciesAgreement',
};

/**
 * Applies a brand's sign-up flow to a member's raw compliance flags:
 * excluded forms stop gating, and signupOrder lists the included built-in
 * forms in the admin's order (any built-in the brand doesn't list — never
 * required in practice — is appended in the generic order so it can't get
 * stranded).
 */
export function applySignupFlow(flags: ComplianceFlags, steps: SignupFlowStep[]): { flags: ComplianceFlags; signupOrder: SignupFormId[] } {
  const effective = { ...flags };
  const listed = new Set<string>();
  const signupOrder: SignupFormId[] = [];
  for (const step of steps) {
    if (!isBuiltIn(step.formId)) continue;
    listed.add(step.formId);
    if (step.included) signupOrder.push(step.formId);
    else effective[FLAG_FOR[step.formId]] = false;
  }
  for (const formId of BUILT_IN_SIGNUP_FORMS) {
    if (!listed.has(formId)) signupOrder.push(formId);
  }
  return { flags: effective, signupOrder };
}
