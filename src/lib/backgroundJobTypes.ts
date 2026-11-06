export type BackgroundJob =
  | { job: 'signed_form_pdf'; brand: 'incore' | 'forca'; pk: string; sk: string; actorUid: string }
  | { job: 'photo_consent_pdf'; childId: string; logId: string };

export const isBackgroundJob = (event: unknown): event is BackgroundJob =>
  typeof (event as { job?: unknown } | null)?.job === 'string';
