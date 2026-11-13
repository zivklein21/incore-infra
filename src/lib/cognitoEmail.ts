import { getEmailBrandTokens } from './emailBranding';

// Content of the emails Cognito itself triggers (password-reset codes,
// email verification, an AdminCreateUser invitation), sent by
// functions/cognitoCustomEmailSender.ts through lib/mailer.ts so they come
// from no-reply@incoretraining.com as "INCORE" or "FORCA" like every other
// email, instead of from Cognito's own no-reply@verificationemail.com.
// Pure (no AWS calls) so test/cognitoEmail.test.ts can cover it.

export type Brand = 'incore' | 'forca';

/** What a trigger source means for the email. null = send nothing. */
export type CognitoEmailKind = 'reset' | 'verify' | 'invite';

export function emailKindForTrigger(triggerSource: string): CognitoEmailKind | null {
  switch (triggerSource) {
    case 'CustomEmailSender_ForgotPassword':
      return 'reset';
    case 'CustomEmailSender_SignUp':
    case 'CustomEmailSender_ResendCode':
    case 'CustomEmailSender_UpdateUserAttribute':
    case 'CustomEmailSender_VerifyUserAttribute':
      return 'verify';
    case 'CustomEmailSender_AdminCreateUser':
      return 'invite';
    default:
      // e.g. CustomEmailSender_AccountTakeOverNotification: advanced security
      // isn't enabled on the pool, so nothing to send.
      return null;
  }
}

/**
 * Same rule as sendOtp.ts: an account found in the INCORE table is INCORE,
 * otherwise found in FORCA is FORCA. Not found anywhere (an admin, or a
 * Cognito user with no member row) falls back to INCORE.
 */
export function pickBrand(inIncore: boolean, inForca: boolean): Brand {
  if (inIncore) return 'incore';
  if (inForca) return 'forca';
  return 'incore';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const TEXT: Record<CognitoEmailKind, { title: string; intro: string; footnote: string; subject: (name: string) => string }> = {
  reset: {
    title: 'איפוס סיסמה',
    intro: 'קיבלנו בקשה לאיפוס הסיסמה שלך. יש להזין את הקוד הבא באפליקציה:',
    footnote: 'הקוד תקף לשעה. אם לא ביקשת לאפס את הסיסמה, אפשר להתעלם מהודעה זו.',
    subject: (name) => `קוד לאיפוס הסיסמה ב-${name}`,
  },
  verify: {
    title: 'אימות כתובת המייל',
    intro: 'יש להזין את הקוד הבא באפליקציה כדי לאמת את כתובת המייל:',
    footnote: 'אם לא ביקשת את הקוד, אפשר להתעלם מהודעה זו.',
    subject: (name) => `קוד האימות שלך ל-${name}`,
  },
  invite: {
    title: 'ברוכים הבאים',
    intro: 'נפתח עבורך חשבון. אפשר להתחבר לאפליקציה עם כתובת המייל הזו והסיסמה הזמנית:',
    footnote: 'בכניסה הראשונה תתבקשו לבחור סיסמה חדשה.',
    subject: (name) => `ברוכים הבאים ל-${name}`,
  },
};

export interface CognitoEmailContent {
  subject: string;
  html: string;
  senderName: string;
}

export function buildCognitoEmail(kind: CognitoEmailKind, brand: Brand, code: string): CognitoEmailContent {
  const t = getEmailBrandTokens(brand);
  const text = TEXT[kind];
  const isPassword = kind === 'invite';
  const codeStyle = isPassword
    ? 'font-size: 28px; font-weight: bold; letter-spacing: 2px;'
    : 'font-size: 42px; font-weight: bold; letter-spacing: 16px;';
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; background-color: #f4f7f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    .header { background-color: ${t.headerBg}; padding: 30px; text-align: center; border-bottom: 1px solid #f0f0f0; }
    .content { padding: 40px 30px; color: #333333; line-height: 1.6; text-align: right; }
    .code-box { background-color: ${t.accentBgLight}; border: 2px solid ${t.accentColor}; border-radius: 12px; padding: 24px; margin: 28px 0; text-align: center; }
    .code { ${codeStyle} color: ${t.accentColor}; font-family: monospace; direction: ltr; }
    .footer { background-color: #f4f7f9; padding: 20px; text-align: center; color: #888888; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="${t.logoUrl}" alt="${t.senderName}" height="${t.logoHeight}" style="height:${t.logoHeight}px;width:auto;max-width:220px;border:0;">
    </div>
    <div class="content">
      <h2 style="color: #2c3e50; margin-top: 0;">${text.title}</h2>
      <p>${text.intro}</p>
      <div class="code-box">
        <div class="code">${escapeHtml(code)}</div>
      </div>
      <p style="font-size: 0.9em; color: #666;">${text.footnote}</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} כל הזכויות שמורות ל-${t.senderName}
    </div>
  </div>
</body>
</html>`;
  return { subject: text.subject(t.senderName), html, senderName: t.senderName };
}
