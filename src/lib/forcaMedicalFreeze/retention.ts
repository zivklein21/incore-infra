import { deleteAfterFor } from '../memberArchive';

// FORCA medical-freeze certificates follow the member archive's retention rule.
// Used when a certificate is stored (store.ts) and again by the retention job.

/**
 * When the certificate is deleted: the later of 7 years after the notice was
 * received and 7 years after the trainee turns 18 (the archive's rule,
 * memberArchive.deleteAfterFor). With no birthday on file, the longest
 * possible: as if she were born the day the notice came in.
 */
export function certificateDeleteAfter(receivedAt: string, birthday: unknown): string {
  const known = typeof birthday === 'string' || typeof birthday === 'number' ? !Number.isNaN(new Date(birthday).getTime()) : false;
  return new Date(deleteAfterFor(receivedAt, known ? birthday : receivedAt) * 1000).toISOString();
}

