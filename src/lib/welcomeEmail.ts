import { getEmailBrandTokens } from './emailBranding';
import { sendEmail } from './mailer';

// Login-details email + initial password generator — shared by
// adminCreateUser.ts (new accounts) and switchProfile.ts (a never-logged-in
// child activated by her parent's switch gets a fresh password emailed).

export function generateInitialPassword(): string {
  // Cognito's password policy (cognito.tf) is numeric-only, min length 6 —
  // matches the old Firebase flow's 7-digit-numeric temp password.
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const IOS_APP_URL     = 'https://apps.apple.com/il/app/incore-studio/id6771026998';
const ANDROID_APP_URL = 'https://play.google.com/store/apps/details?id=com.workout.incore';
// Hosted under the incore-production-uploads bucket's email-assets/ prefix —
// the one deliberate public-read exception on an otherwise fully private
// bucket (see s3.tf) — email clients fetch embedded images unauthenticated,
// so a presigned URL isn't an option here. FORCA is the same app/app-store
// listing under a different in-app brand mode, so the download badges/links
// are shared — only the logo/colors/copy below vary by brand.
const APP_STORE_BADGE_URL   = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/appstore.png';
const GOOGLE_PLAY_BADGE_URL = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/googleplay.png';

// FORCA trainees/parents are addressed in feminine Hebrew throughout the
// app (see e.g. FormsStatusTab.tsx's copy) — mirrored in the forca copy
// below; INCORE's existing masculine-default copy is left as-is.
// Coaches get this same credentials email, but image-free (see the
// isCoach param) — plain text/links standing in for the header logo and
// the two app-store badge images below, no <img> tags at all.
export async function sendWelcomeEmail(email: string, name: string, password: string, brand: 'incore' | 'forca', isCoach = false): Promise<void> {
  const t = getEmailBrandTokens(brand);
  const intro = brand === 'forca'
    ? 'איזה כיף לראות אותך איתנו! אנחנו נרגשים שהצטרפת ל-FORCA.'
    : 'איזה כיף לראות אותך איתנו! אנחנו נרגשים שהצטרפת לאפליקציה שלנו.';

  const header = isCoach
    ? `<div style="padding:24px 30px;text-align:center;border-bottom:1px solid #eeeeee;background-color:${t.headerBg};">
      <span style="font-size:20px;font-weight:700;color:#ffffff;">${t.senderName}</span>
    </div>`
    : `<div style="padding:24px 30px;text-align:center;border-bottom:1px solid #eeeeee;background-color:${t.headerBg};">
      <img src="${t.logoUrl}" alt="${t.senderName}" height="${t.logoHeight}" style="height:${t.logoHeight}px;width:auto;max-width:220px;border:0;">
    </div>`;

  const footer = isCoach
    ? `<div style="background-color:${t.footerBg};padding:30px;text-align:center;">
      <p style="margin:0 0 6px 0;font-size:17px;font-weight:700;color:${t.accentColor};">הורד את האפליקציה עכשיו</p>
      <p style="margin:0 0 20px 0;font-size:13px;color:#666;">זמין ל-iPhone וגם לאנדרואיד</p>
      <a href="${IOS_APP_URL}" style="color:${t.accentColor};font-weight:600;margin:0 10px;" target="_blank" rel="noopener noreferrer">App Store</a>
      <a href="${ANDROID_APP_URL}" style="color:${t.accentColor};font-weight:600;margin:0 10px;" target="_blank" rel="noopener noreferrer">Google Play</a>
    </div>`
    : `<div style="background-color:${t.footerBg};padding:30px;text-align:center;">
      <p style="margin:0 0 6px 0;font-size:17px;font-weight:700;color:${t.accentColor};">הורד את האפליקציה עכשיו</p>
      <p style="margin:0 0 20px 0;font-size:13px;color:#666;">זמין ל-iPhone וגם לאנדרואיד</p>
      <a href="${ANDROID_APP_URL}" style="display:inline-block;margin:0 6px;" target="_blank" rel="noopener noreferrer">
        <img src="${GOOGLE_PLAY_BADGE_URL}" alt="הורד מ-Google Play" height="48" style="height:48px;width:auto;border:0;">
      </a>
      <a href="${IOS_APP_URL}" style="display:inline-block;margin:0 6px;" target="_blank" rel="noopener noreferrer">
        <img src="${APP_STORE_BADGE_URL}" alt="הורד מה-App Store" height="48" style="height:48px;width:auto;border:0;">
      </a>
    </div>`;

  await sendEmail({
    senderName: t.senderName,
    to: email,
    subject: brand === 'forca'
      ? `ברוכה הבאה ל-${t.senderName}! פרטי ההתחברות שלך בפנים`
      : `ברוך הבא ל-${t.senderName}! פרטי ההתחברות שלך בפנים`,
    html: `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#f4f7f9;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;direction:rtl;">
  <div style="max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,0.05);">
    ${header}
    <div style="padding:40px 30px;color:#333333;line-height:1.6;text-align:right;">
      <h2 style="color:#2c3e50;margin-top:0;">שלום ${name},</h2>
      <p style="margin:0 0 16px 0;">${intro}</p>
      <p>החשבון שלך הוגדר בהצלחה. להלן פרטי ההתחברות האישיים שלך:</p>
      <div style="background-color:#f8f9fa;border-right:4px solid ${t.accentColor};padding:20px;margin:25px 0;border-radius:4px;">
        <p style="margin:0 0 10px 0;"><strong>שם משתמש:</strong> <a href="mailto:${email}" style="color:${t.accentColor};">${email}</a></p>
        <p style="margin:0;"><strong>סיסמה זמנית:</strong> <span style="color:${t.accentColor};font-weight:bold;">${password}</span></p>
      </div>
      <p style="font-size:0.9em;color:#666;">* ליתר ביטחון, אנו ממליצים להחליף את הסיסמה הזמנית לאחר הכניסה הראשונה.</p>
    </div>
    ${footer}
  </div>
</body></html>`,
  }, 'adminCreateUser');
}
