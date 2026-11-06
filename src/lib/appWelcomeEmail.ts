// The post-registration "welcome, the app awaits you" email, sent by
// sendWelcomeEmail.ts. Ported verbatim from incore-app's
// HealthDeclarationScreen.tsx buildAppWelcomeEmailHtml(): the server now
// builds it itself instead of trusting client-supplied subject/html, which
// used to let any signed-in member send arbitrary HTML from our sender to any
// address — unacceptable once that sender is our own SES domain.

const IOS_APP_URL           = 'https://apps.apple.com/il/app/incore-studio/id6771026998';
const ANDROID_APP_URL       = 'https://play.google.com/store/apps/details?id=com.workout.incore';
const APP_STORE_BADGE_URL   = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/appstore.png';
const GOOGLE_PLAY_BADGE_URL = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/googleplay.png';

export function appWelcomeEmailSubject(brand: 'incore' | 'forca'): string {
  return brand === 'forca' ? 'ברוכה הבאה ל-FORCA! האפליקציה מחכה לך 📱' : 'ברוכה הבאה ל-INCORE! האפליקציה מחכה לך 📱';
}

export function buildAppWelcomeEmailHtml(brand: 'incore' | 'forca'): string {
  const accent = brand === 'forca' ? '#fdd5ed' : '#DEFF9A';
  const brandName = brand === 'forca' ? 'FORCA' : 'INCORE';
  const footerText = brand === 'forca'
    ? 'נתקלת בבעיה? המאמנת שלך תמיד זמינה עבורך בלשונית התמיכה.'
    : 'נתקלת בבעיה? מנהלת הסטודיו תמיד זמינה עבורך בלשונית התמיכה.';
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background-color: #000000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; }
    .wrapper { background-color: #000000; padding: 40px 20px; }
    .container { max-width: 500px; margin: 0 auto; background-color: #0F0F0F; border-radius: 16px; overflow: hidden; border: 1px solid #1E1E1E; }
    .content { padding: 40px; direction: rtl; text-align: right; }
    h2 { color: #FFFFFF; font-size: 26px; font-weight: 700; margin: 0 0 20px 0; line-height: 1.35; }
    .body-text { color: #FFFFFF; font-size: 16px; line-height: 1.75; margin: 0 0 36px 0; }
    .badge-section { text-align: center; margin: 0 0 36px 0; }
    .badge-link { display: inline-block; margin: 6px 6px; vertical-align: middle; }
    .badge-link img { height: 48px; width: auto; display: block; border: 0; }
    .footer-text { color: #A0A0A0; font-size: 13px; line-height: 1.6; text-align: center; margin: 0; padding-top: 24px; border-top: 1px solid #1E1E1E; }
    @media only screen and (max-width: 480px) {
      .content { padding: 28px 20px; }
      .badge-link { display: block; margin: 8px auto; text-align: center; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="content">
        <h2>ברוכה הבאה ל-<span style="color: ${accent};">${brandName}</span> 🔥</h2>
        <p class="body-text">
          ההרשמה והצהרת הבריאות הושלמו בהצלחה!<br>
          עכשיו נשאר רק להוריד את האפליקציה ולתפוס את המקום שלך באימון הקרוב.
        </p>
        <div class="badge-section">
          <a href="${IOS_APP_URL}" class="badge-link" target="_blank" rel="noopener noreferrer">
            <img
              src="${APP_STORE_BADGE_URL}"
              alt="הורד מה-App Store"
              height="48"
            >
          </a>
          <a href="${ANDROID_APP_URL}" class="badge-link" target="_blank" rel="noopener noreferrer">
            <img
              src="${GOOGLE_PLAY_BADGE_URL}"
              alt="הורד מ-Google Play"
              height="48"
            >
          </a>
        </div>
        <p class="footer-text">${footerText}</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}
