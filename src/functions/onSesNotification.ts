import type { SNSEvent } from 'aws-lambda';
import { describeSesEvent, type SesEvent } from '../lib/sesEvents';

// SNS trigger (topic incore-ses-events, fed by the incore-transactional SES
// configuration set — see ses.tf). Logs bounces, complaints, rejects and
// delivery delays with masked addresses. Bounced/complaining addresses are
// suppressed by SES itself, so nothing is written here.
export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    let parsed: SesEvent;
    try {
      parsed = JSON.parse(record.Sns.Message);
    } catch {
      console.error('[onSesNotification] unparseable SNS message', record.Sns.MessageId);
      continue;
    }
    for (const line of describeSesEvent(parsed)) {
      if (parsed.eventType === 'DeliveryDelay') console.warn(`[onSesNotification] ${line}`);
      else console.error(`[onSesNotification] ${line}`);
    }
  }
}
