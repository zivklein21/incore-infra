import type { TemplateSection } from '../formTemplates/schema';

// FORCA photo / publication consent. Valid only while BOTH the parent and the
// trainee agree. Pure rules here, so they can be tested without a database.

export type ConsentRole = 'parent' | 'trainee';
export type ConsentDecision = 'agree' | 'refuse';
export type ConsentStatus = 'approved' | 'pending' | 'not_approved';

export interface ConsentState {
  parent: ConsentDecision | null;
  trainee: ConsentDecision | null;
}

export const NO_CONSENT: ConsentState = { parent: null, trainee: null };

/** Anything short of both agreeing is not consent. 'pending' means one side agreed and the other hasn't. */
export function consentStatus(s: ConsentState): ConsentStatus {
  if (s.parent === 'agree' && s.trainee === 'agree') return 'approved';
  return s.parent === 'agree' || s.trainee === 'agree' ? 'pending' : 'not_approved';
}

/**
 * Refusing takes effect at once and doesn't wait for anyone. It also clears
 * the other side's earlier agreement: otherwise a parent who withdrew and
 * later agreed again would restore consent on an agreement the trainee gave
 * before the withdrawal, instead of asking them again.
 */
export function applyConsentChange(s: ConsentState, role: ConsentRole, decision: ConsentDecision): ConsentState {
  if (decision === 'refuse') return { ...NO_CONSENT, [role]: 'refuse' };
  return { ...s, [role]: 'agree' };
}

export const otherSide = (role: ConsentRole): ConsentRole => (role === 'parent' ? 'trainee' : 'parent');

/** The form an approved consent starts from — identified by its name, there's no dedicated setting for it. */
export const isPhotoConsentForm = (name: string) => /צילום/.test(name);

/** The latest change wins, whether that's a change made here or the sign-up form being signed later. */
export function currentConsent(
  saved: (ConsentState & { updatedAt: string }) | null,
  form: { approved: boolean; at: string } | null,
): ConsentState {
  if (saved && (!form || saved.updatedAt >= form.at)) return { parent: saved.parent, trainee: saved.trainee };
  return form?.approved ? { parent: 'agree', trainee: 'agree' } : NO_CONSENT;
}

const MAX_STROKES = 500;
const MAX_SIGNATURE_CHARS = 300_000;

export function signatureError(typedName: unknown, paths: unknown): string | null {
  if (typeof typedName !== 'string' || !typedName.trim()) return 'missing_name';
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_STROKES) return 'missing_signature';
  if (paths.some(p => typeof p !== 'string' || !p)) return 'missing_signature';
  return paths.join('').length > MAX_SIGNATURE_CHARS ? 'signature_too_large' : null;
}

const DECISION_LABEL: Record<ConsentDecision, string> = { agree: 'מסכים/ה', refuse: 'לא מסכים/ה' };
const ROLE_LABEL: Record<ConsentRole, string> = { parent: 'הורה', trainee: 'חניכה' };
const STATUS_LABEL: Record<ConsentStatus, string> = {
  approved: 'מאושר — שני הצדדים הסכימו',
  pending: 'ממתין לאישור הצד השני',
  not_approved: 'לא מאושר',
};

/** The one-page signed record of a single change, in the same PDF layout as every other signed form. */
export function consentPdfContent(input: { role: ConsentRole; decision: ConsentDecision; status: ConsentStatus; childName: string }): {
  sections: TemplateSection[]; answers: Record<string, string>;
} {
  return {
    sections: [{
      id: 'consent',
      title: 'שינוי הסכמה לצילום ולפרסום',
      unnumbered: true,
      fields: [
        { id: 'child', type: 'short_text', label: 'חניכה', required: true, filledBy: input.role },
        { id: 'by', type: 'short_text', label: 'החותם/ת', required: true, filledBy: input.role },
        { id: 'decision', type: 'short_text', label: 'החלטה', required: true, filledBy: input.role },
        { id: 'status', type: 'short_text', label: 'מצב ההסכמה לאחר השינוי', required: true, filledBy: input.role },
        { id: 'signature', type: 'signature', label: 'חתימה', required: true, filledBy: input.role },
      ],
    }],
    answers: {
      child: input.childName,
      by: ROLE_LABEL[input.role],
      decision: DECISION_LABEL[input.decision],
      status: STATUS_LABEL[input.status],
    },
  };
}
