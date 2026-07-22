import type { DynamoDBStreamEvent } from 'aws-lambda';
import * as nodemailer from 'nodemailer';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { newImage } from '../lib/dynamoStream';
import type { MailItem } from '../lib/entities';

// DynamoDB Stream trigger — fires on INSERT of a PK=MAIL#<id> item (an
// email-to-send record). GMAIL_APP_PASSWORD sourced from Secrets Manager,
// same pattern as sendOtp.ts.
const FROM_EMAIL = 'incoreworkout@gmail.com';

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

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: FROM_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"INCORE" <${FROM_EMAIL}>`,
      to,
      subject,
      html,
    });

    // Delete the item so credentials don't linger in the table.
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } }));

    console.log(`[processMail] Sent to ${to} (${item.PK})`);
  }
}
