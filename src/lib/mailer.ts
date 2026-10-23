import * as nodemailer from 'nodemailer';

// Single send path for every outbound email (sendOtp.ts, processMail.ts,
// adminCreateUser.ts). Gmail SMTP is being replaced by Amazon SES on
// incoretraining.com; MAIL_PROVIDER controls the rollout:
//  - 'gmail':             old behavior, Gmail SMTP only.
//  - 'ses_with_fallback': SES first; on ANY SES error (domain not verified
//                         yet, sandbox rejecting an unverified recipient,
//                         client unavailable, ...) send via Gmail instead, so
//                         no member ever misses a password-reset code.
//  - 'ses':               SES only, once production access is granted.
// A code constant rather than a Lambda env var on purpose: env vars are set
// on the shared aws_lambda_function.fn block, so changing one redeploys all
// ~330 functions; this keeps the switch to the three sending functions.
export type MailProvider = 'gmail' | 'ses_with_fallback' | 'ses';
export const MAIL_PROVIDER: MailProvider = 'ses_with_fallback';

export const SES_FROM_ADDRESS = 'no-reply@incoretraining.com';
export const SES_CONFIGURATION_SET = 'incore-transactional';
export const REPLY_TO_ADDRESS = 'incoreworkout@gmail.com';
const SES_REGION = 'eu-central-1';
const GMAIL_ADDRESS = 'incoreworkout@gmail.com';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  /** Display name — 'INCORE' or 'FORCA' (see emailBranding.ts). */
  senderName: string;
}

/** a***@gmail.com — enough to tell recipients apart in logs. */
export function maskEmailForLog(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/** RFC 5322 display-name form; quotes/backslashes in the name are escaped. */
export function formatFromAddress(senderName: string, address: string): string {
  return `"${senderName.replace(/["\\]/g, '\\$&')}" <${address}>`;
}

async function sendViaSes(mail: OutgoingEmail): Promise<void> {
  // Provided by the Lambda nodejs20.x runtime (full AWS SDK v3) — not
  // bundled and not in the layer, see build.mjs. Loaded lazily so a missing
  // client surfaces as an ordinary SES error (and falls back to Gmail)
  // instead of crashing the whole function at import time. require(), not
  // import(): the runtime exposes its SDK via NODE_PATH, which only the
  // CommonJS resolver honors.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2') as typeof import('@aws-sdk/client-sesv2');
  const client = new SESv2Client({ region: SES_REGION });
  await client.send(new SendEmailCommand({
    FromEmailAddress: formatFromAddress(mail.senderName, SES_FROM_ADDRESS),
    Destination: { ToAddresses: [mail.to] },
    ReplyToAddresses: [REPLY_TO_ADDRESS],
    ConfigurationSetName: SES_CONFIGURATION_SET,
    Content: {
      Simple: {
        Subject: { Data: mail.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: mail.html, Charset: 'UTF-8' } },
      },
    },
  }));
}

async function sendViaGmail(mail: OutgoingEmail): Promise<void> {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_ADDRESS, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: formatFromAddress(mail.senderName, GMAIL_ADDRESS),
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
  });
}

/** Sends one email and returns which provider delivered it. Throws only if every allowed provider failed. */
export async function sendEmail(mail: OutgoingEmail, source: string, provider: MailProvider = MAIL_PROVIDER): Promise<'ses' | 'gmail'> {
  const who = maskEmailForLog(mail.to);
  if (provider !== 'gmail') {
    try {
      await sendViaSes(mail);
      console.log(`[mailer:${source}] provider=ses to=${who}`);
      return 'ses';
    } catch (err: any) {
      if (provider === 'ses') throw err;
      console.warn(`[mailer:${source}] SES failed (${err?.name ?? 'Error'}: ${err?.message ?? err}) — falling back to Gmail for ${who}`);
    }
  }
  await sendViaGmail(mail);
  console.log(`[mailer:${source}] provider=gmail to=${who}`);
  return 'gmail';
}
