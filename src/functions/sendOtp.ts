import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import * as nodemailer from 'nodemailer';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';

// POST /sendOtp
// Auth: NONE — this runs before login (forgot-password flow), so it must NOT
// be behind the API Gateway Cognito JWT authorizer. Configure its route
// without an authorizer, unlike the rest of this batch.
//
// GMAIL_APP_PASSWORD should be sourced from Secrets Manager / SSM Parameter
// Store and injected as this Lambda's environment variable at deploy time —
// left as process.env here to match how TABLE_NAME is wired (see dynamo.ts).

const FROM_EMAIL = 'incoreworkout@gmail.com';
const LOGO_URL = 'https://firebasestorage.googleapis.com/v0/b/incore-f8a76.firebasestorage.app/o/Logo.png?alt=media&token=17ada6c2-544e-4e9e-993d-87ef2896a03b';

function generateOtp(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || local.length <= 1) return email;
  return `${local[0]}${'*'.repeat(local.length - 1)}@${domain}`;
}

function buildOtpEmailHtml(code: string): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; background-color: #f4f7f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    .header { background-color: #ffffff; padding: 30px; text-align: center; border-bottom: 1px solid #f0f0f0; }
    .content { padding: 40px 30px; color: #333333; line-height: 1.6; text-align: right; }
    .code-box { background-color: #f3eeff; border: 2px solid #5C3A8F; border-radius: 12px; padding: 24px; margin: 28px 0; text-align: center; }
    .code { font-size: 42px; font-weight: bold; letter-spacing: 16px; color: #5C3A8F; font-family: monospace; }
    .footer { background-color: #f4f7f9; padding: 20px; text-align: center; color: #888888; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="${LOGO_URL}" alt="INCORE" style="max-width: 150px;">
    </div>
    <div class="content">
      <h2 style="color: #2c3e50; margin-top: 0;">איפוס סיסמה</h2>
      <p>קיבלנו בקשה לאיפוס הסיסמה שלך. הכניסי את הקוד הבא באפליקציה:</p>
      <div class="code-box">
        <div class="code">${code}</div>
      </div>
      <p style="font-size: 0.9em; color: #666;">הקוד תקף ל-10 דקות בלבד. אם לא ביקשת לאפס את הסיסמה, אפשר להתעלם מהודעה זו.</p>
    </div>
    <div class="footer">
      &copy; 2026 כל הזכויות שמורות ל-INCORE
    </div>
  </div>
</body>
</html>`;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { email?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing email' });
  }

  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  if (!email) return json(400, { error: 'Missing email' });

  const memberRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk',
    ExpressionAttributeValues: { ':pk': `EMAIL#${email}` },
    Limit: 1,
  }));
  const member = (memberRes.Items ?? [])[0] as MemberProfileItem | undefined;
  if (!member) return json(404, { error: 'No account found with this email' });

  const memberId = member.PK.replace('MEMBER#', '');
  const code = generateOtp();
  const expiresAtMs = Date.now() + 10 * 60 * 1000;

  // Invalidate any prior unused OTPs for this email, then write the new one.
  const staleRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    FilterExpression: '#used = :false',
    ExpressionAttributeNames: { '#used': 'used' },
    ExpressionAttributeValues: { ':pk': `OTP#${email}`, ':false': false },
  }));
  await Promise.all((staleRes.Items ?? []).map((item) =>
    ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: item.SK } })),
  ));

  const otpId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `OTP#${email}`,
      SK: `CODE#${otpId}`,
      email,
      memberId,
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtEpoch: Math.floor(expiresAtMs / 1000),
      used: false,
    },
  }));

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `"INCORE" <${FROM_EMAIL}>`,
    to: email,
    subject: 'קוד האימות שלך ל-INCORE',
    html: buildOtpEmailHtml(code),
  });

  return json(200, { success: true, maskedEmail: maskEmail(email) });
}
