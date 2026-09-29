import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import * as nodemailer from 'nodemailer';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import { getEmailBrandTokens } from '../lib/emailBranding';
import type { MemberProfileItem } from '../lib/entities';

// POST /sendOtp
// Auth: NONE — this runs before login (forgot-password flow), so it must NOT
// be behind the API Gateway Cognito JWT authorizer. Configure its route
// without an authorizer, unlike the rest of this batch.
//
// GMAIL_APP_PASSWORD should be sourced from Secrets Manager / SSM Parameter
// Store and injected as this Lambda's environment variable at deploy time —
// left as process.env here to match how TABLE_NAME is wired (see dynamo.ts).
//
// FORCA's member data lives in a fully separate table (FORCA_TABLE_NAME —
// see dynamo.ts), and the email alone doesn't tell us which one a given
// account lives in — this used to only ever query TABLE_NAME, silently
// 404ing "No account found" for every FORCA member's forgot-password
// attempt. Now queries both in parallel and brands the email (and the OTP
// record's own table) off whichever one actually has her.

const FROM_EMAIL = 'incoreworkout@gmail.com';

function generateOtp(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || local.length <= 1) return email;
  return `${local[0]}${'*'.repeat(local.length - 1)}@${domain}`;
}

function buildOtpEmailHtml(code: string, brand: 'incore' | 'forca'): string {
  const t = getEmailBrandTokens(brand);
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; background-color: #f4f7f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    .header { background-color: ${t.headerBg}; padding: 30px; text-align: center; border-bottom: 1px solid #f0f0f0; }
    .content { padding: 40px 30px; color: #333333; line-height: 1.6; text-align: right; }
    .code-box { background-color: ${t.accentBgLight}; border: 2px solid ${t.accentColor}; border-radius: 12px; padding: 24px; margin: 28px 0; text-align: center; }
    .code { font-size: 42px; font-weight: bold; letter-spacing: 16px; color: ${t.accentColor}; font-family: monospace; }
    .footer { background-color: #f4f7f9; padding: 20px; text-align: center; color: #888888; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="${t.logoUrl}" alt="${t.senderName}" height="${t.logoHeight}" style="height:${t.logoHeight}px;width:auto;max-width:220px;border:0;">
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
      &copy; 2026 כל הזכויות שמורות ל-${t.senderName}
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

  const [incoreRes, forcaRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': `EMAIL#${email}` },
      Limit: 1,
    })),
    ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': `EMAIL#${email}` },
      Limit: 1,
    })),
  ]);
  const incoreMember = (incoreRes.Items ?? [])[0] as MemberProfileItem | undefined;
  const forcaMember = (forcaRes.Items ?? [])[0] as MemberProfileItem | undefined;
  const member = incoreMember ?? forcaMember;
  if (!member) return json(404, { error: 'No account found with this email' });

  const brand: 'incore' | 'forca' = incoreMember ? 'incore' : 'forca';
  const tableName = incoreMember ? TABLE_NAME : FORCA_TABLE_NAME;

  const memberId = member.PK.replace('MEMBER#', '');
  const code = generateOtp();
  const expiresAtMs = Date.now() + 10 * 60 * 1000;

  // Invalidate any prior unused OTPs for this email, then write the new one.
  const staleRes = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    FilterExpression: '#used = :false',
    ExpressionAttributeNames: { '#used': 'used' },
    ExpressionAttributeValues: { ':pk': `OTP#${email}`, ':false': false },
  }));
  await Promise.all((staleRes.Items ?? []).map((item) =>
    ddb.send(new DeleteCommand({ TableName: tableName, Key: { PK: item.PK, SK: item.SK } })),
  ));

  const otpId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: tableName,
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

  const t = getEmailBrandTokens(brand);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `"${t.senderName}" <${FROM_EMAIL}>`,
    to: email,
    subject: `קוד האימות שלך ל-${t.senderName}`,
    html: buildOtpEmailHtml(code, brand),
  });

  return json(200, { success: true, maskedEmail: maskEmail(email) });
}
