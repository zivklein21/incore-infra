import type { FormSubmissionItem } from './submissions';

// How a form sits on a parent's Forms page. Pure, so the rules are testable.

export type ParentSection = 'to_sign' | 'waiting_trainee' | 'signed' | 'hidden';

interface ParentRow {
  status: unknown;
  myRoles: string[];
  waiting: string[];
  signers?: unknown;
  acknowledgers?: unknown;
  showIn?: unknown;
}

const listedRole = (roles: unknown, role: string) => Array.isArray(roles) && roles.includes(role);
const listed = (roles: unknown) => listedRole(roles, 'parent');

/** Is the parent a signer or acknowledger of this form (vs a form only the trainee signs)? */
export const parentIsSigner = (f: ParentRow) => listed(f.signers) || listed(f.acknowledgers);

/**
 * To sign = only while the PARENT's part is missing. A form waiting on the
 * trainee alone never asks the parent, even when the trainee signs it on the
 * parent's phone. A completed form the parent has no part in follows the
 * admin's "which profile shows it" setting; one they signed always shows.
 */
export function parentSection(f: ParentRow): ParentSection {
  if (f.status === 'completed') return parentIsSigner(f) || f.showIn !== 'trainee' ? 'signed' : 'hidden';
  if (f.myRoles.includes('parent')) return 'to_sign';
  return f.waiting.length || f.myRoles.length ? 'waiting_trainee' : 'hidden';
}

/**
 * Does this form stop the PARENT at first login? Their own part, or the
 * trainee's part when it can only be done on the parent's phone. A trainee
 * part that can wait for her own phone never holds the parent up.
 */
export const parentOwesAtSignup = (f: { myRoles: string[]; traineeDevice?: unknown }) =>
  f.myRoles.includes('parent') || (f.myRoles.length > 0 && f.traineeDevice === 'parent_phone');

interface FlowRow { myRoles: string[]; traineeDevice?: unknown; deviceRoles?: unknown; signedRoles?: unknown; ackRoles?: unknown }

const did = (f: FlowRow, role: string) => listedRole(f.signedRoles, role) || listedRole(f.ackRoles, role);
/** A row with no part on this device (an ended or replaced form) was never a step of this flow. */
const hasPart = (f: FlowRow) => Array.isArray(f.deviceRoles) && f.deviceRoles.length > 0;

/** The parent's sign-up steps, done or not: what they owe now plus what they already did here. */
export const inParentSignupFlow = (f: FlowRow) => hasPart(f)
  && (parentOwesAtSignup(f) || did(f, 'parent') || (f.traineeDevice === 'parent_phone' && did(f, 'trainee')));

/** The trainee's sign-up steps on her own phone, done or not. */
export const inTraineeSignupFlow = (f: FlowRow) => hasPart(f) && (f.myRoles.length > 0 || did(f, 'trainee'));

export const withParentSections = <T extends ParentRow>(rows: T[]) =>
  rows.map(f => ({ ...f, parentSection: parentSection(f), parentIsSigner: parentIsSigner(f) }));

/** The badge: forms waiting for the parent, and nothing else. */
export const parentPendingCount = (rows: { parentSection: ParentSection }[]) =>
  rows.filter(f => f.parentSection === 'to_sign').length;

/**
 * Completed submissions of this child that no current form row shows.
 * previousVersion = the same assignment has a current row, i.e. it was
 * replaced by a version that needs signing again.
 */
export function orphanedSignedForms(
  subs: FormSubmissionItem[], childId: string, rows: { templateId: string; assignmentId: string; submissionId?: unknown }[],
): { sub: FormSubmissionItem; previousVersion: boolean }[] {
  const shown = new Set(rows.map(r => r.submissionId).filter(Boolean));
  return subs
    .filter(s => s.childId === childId && s.status === 'completed' && !shown.has(s.submissionId))
    .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))
    .map(sub => ({ sub, previousVersion: rows.some(r => r.templateId === sub.templateId && r.assignmentId === sub.assignmentId) }));
}
