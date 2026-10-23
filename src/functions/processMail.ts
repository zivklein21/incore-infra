import type { DynamoDBStreamEvent } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { newImage } from '../lib/dynamoStream';
import { getEmailBrandTokens } from '../lib/emailBranding';
import { maskEmailForLog, sendEmail } from '../lib/mailer';
import type { MailItem } from '../lib/entities';

// DynamoDB Stream trigger — fires on INSERT of a PK=MAIL#<id> item (an
// email-to-send record, queued by sendWelcomeEmail.ts). Sent through
// lib/mailer.ts (SES, Gmail fallback during the migration).
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT') continue;
    const item = newImage<MailItem>(record);
    if (!item || !item.PK.startsWith('MAIL#')) continue;

    const to = item.to;
    const subject = item.message?.subject ?? '';
    const html = item.message?.html ?? '';

    if (!to) {
      console.error(`[processMail] ${item.PK}: missing "to" field — skipping`);
      continue;
    }

    const { senderName } = getEmailBrandTokens(item.brand === 'forca' ? 'forca' : 'incore');
    await sendEmail({ to, subject, html, senderName }, 'processMail');

    // Delete the item so credentials don't linger in the table.
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } }));

    console.log(`[processMail] Sent to ${maskEmailForLog(to)} (${item.PK})`);
  }
}
