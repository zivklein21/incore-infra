import type { SignerRole } from './schema';

// When is a member's copy of a template-based form complete? Pure so the
// signing endpoints (per-signer records, next step of the forms upgrade)
// and Forms Status share one rule:
//
//   every signer has a SIGNATURE and every acknowledger an ACKNOWLEDGMENT,
//   each made on a version at or after the latest version that was
//   published with "Require re-sign" (or on any version if none was).
//
// So editing a form never invalidates anyone's signature or acknowledgment
// unless the admin explicitly asked for re-signing on publish — and then a
// new acknowledgment is required too, not just new signatures.

export type ParticipationKind = 'signature' | 'acknowledgment';

export interface ParticipationRecord {
  role: SignerRole;
  kind: ParticipationKind;
  /** Template version the record was made on. */
  version: number;
  at: string;
}

export interface CompletionInput {
  signers: SignerRole[];
  acknowledgers: SignerRole[];
  /** Latest version published with requireResign=true; 0 when none. */
  resignFromVersion: number;
  records: ParticipationRecord[];
}

export interface CompletionStatus {
  complete: boolean;
  /** Signers who still need to sign (incl. ones whose signature predates a re-sign version). */
  missingSignatures: SignerRole[];
  /** Acknowledgers who still need to confirm. Only actionable once missingSignatures is empty. */
  missingAcknowledgments: SignerRole[];
}

const hasValid = (records: ParticipationRecord[], role: SignerRole, kind: ParticipationKind, fromVersion: number) =>
  records.some(r => r.role === role && r.kind === kind && r.version >= fromVersion);

export function completionStatus({ signers, acknowledgers, resignFromVersion, records }: CompletionInput): CompletionStatus {
  const missingSignatures = signers.filter(role => !hasValid(records, role, 'signature', resignFromVersion));
  const missingAcknowledgments = acknowledgers.filter(role => !hasValid(records, role, 'acknowledgment', resignFromVersion));
  return {
    complete: missingSignatures.length === 0 && missingAcknowledgments.length === 0,
    missingSignatures,
    missingAcknowledgments,
  };
}
