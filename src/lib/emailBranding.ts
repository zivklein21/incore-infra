// Shared color/logo tokens for the two brand skins every outbound member
// email (sendOtp.ts, adminCreateUser.ts's welcome email) needs to render in
// — INCORE's purple and FORCA's pink, mirroring incore-app's own
// colors.purpleVeryDark/forcaDarkPink split. Centralized so a future brand
// color tweak (or a third brand) is a one-file change instead of hunting
// through every inline-styled email template.
//
// FORCA's own logo (incore-app's src/shared/assets/icons/forca_logo.png) is
// a transparent-background white wordmark meant to sit on a pink surface —
// unlike INCORE's own logo, which is already flat-colored and sits on
// white. Composited once onto its forcaDarkPink background and uploaded to
// the same public email-assets/ S3 prefix (see s3.tf) rather than shipped
// as a raw transparent PNG, since an email client can't apply a colored
// background behind an <img> the way PageBanner.tsx's <View> can.
export interface EmailBrandTokens {
  brand: 'incore' | 'forca';
  senderName: string;
  logoUrl: string;
  logoHeight: number;
  /** Header strip behind the logo — white for INCORE (flat-colored logo), the brand color itself for FORCA (white-on-color wordmark). */
  headerBg: string;
  accentColor: string;
  accentBgLight: string;
  footerBg: string;
}

const INCORE_LOGO_URL = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/Logo.png';
const FORCA_LOGO_URL = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/ForcaLogoEmail.png';

export function getEmailBrandTokens(brand: 'incore' | 'forca'): EmailBrandTokens {
  if (brand === 'forca') {
    return {
      brand: 'forca',
      senderName: 'FORCA',
      logoUrl: FORCA_LOGO_URL,
      logoHeight: 40,
      headerBg: '#7A004B',      // colors.forcaDarkPink
      accentColor: '#7A004B',
      accentBgLight: '#fdd5ed', // colors.forcaLightPink
      footerBg: '#fdd5ed',
    };
  }
  return {
    brand: 'incore',
    senderName: 'INCORE',
    logoUrl: INCORE_LOGO_URL,
    logoHeight: 48,
    headerBg: '#ffffff',
    accentColor: '#5C3A8F',     // colors.purpleVeryDark
    accentBgLight: '#f3eeff',   // colors.purpleVeryLight
    footerBg: '#f4f2fa',
  };
}
