import { maskEmailForLog } from './mailer';

// SES event-publishing payloads (configuration set incore-transactional →
// SNS incore-ses-events → onSesNotification.ts). Only what we log is typed.
// Suppression itself is done by SES (configuration-set + account-level
// suppression list for BOUNCE/COMPLAINT), so this is visibility only.
export interface SesEvent {
  eventType: string;
  mail?: { messageId?: string; commonHeaders?: { subject?: string } };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
  complaint?: { complaintFeedbackType?: string; complainedRecipients?: { emailAddress: string }[] };
  reject?: { reason?: string };
  deliveryDelay?: { delayType?: string; delayedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
  failure?: { errorMessage?: string };
}

/** One log line per affected recipient, addresses masked. */
export function describeSesEvent(e: SesEvent): string[] {
  const msg = e.mail?.messageId ?? '?';
  switch (e.eventType) {
    case 'Bounce':
      return (e.bounce?.bouncedRecipients ?? []).map((r) =>
        `Bounce ${e.bounce?.bounceType ?? '?'}/${e.bounce?.bounceSubType ?? '?'} to=${maskEmailForLog(r.emailAddress)} msg=${msg}${r.diagnosticCode ? ` diag="${r.diagnosticCode}"` : ''}`);
    case 'Complaint':
      return (e.complaint?.complainedRecipients ?? []).map((r) =>
        `Complaint ${e.complaint?.complaintFeedbackType ?? 'unspecified'} to=${maskEmailForLog(r.emailAddress)} msg=${msg}`);
    case 'DeliveryDelay':
      return (e.deliveryDelay?.delayedRecipients ?? []).map((r) =>
        `DeliveryDelay ${e.deliveryDelay?.delayType ?? '?'} to=${maskEmailForLog(r.emailAddress)} msg=${msg}`);
    case 'Reject':
      return [`Reject reason="${e.reject?.reason ?? '?'}" msg=${msg}`];
    case 'Rendering Failure':
    case 'RenderingFailure':
      return [`RenderingFailure "${e.failure?.errorMessage ?? '?'}" msg=${msg}`];
    default:
      return [`${e.eventType} msg=${msg}`];
  }
}
