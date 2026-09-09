import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import * as nodemailer from 'nodemailer';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { bridgeTokenToBillingAgreement } from '../lib/hypBillingAgreements';
import { createFamilyLink } from '../lib/familyLinks';
import { recordSystemAlert } from '../lib/alerts';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminCreateUser
// Auth: Cognito JWT, caller must be admin
// Body: { email, firstName, lastName, phone, birthday?, age?, requireHealthForm?, requireRegistrationForm?, membershipId?, accountType?, brand?, parentFirstName?, parentLastName?, parentPhone?, parentEmail? }
//
// accountType: 'parent_only' (Family Accounts) marks a member created solely
// to hold family links — no membership/booking of their own; the client
// hides their schedule/booking tab and leads with their linked child's
// profile instead (see the Family Accounts plan). Omit or 'member' for a
// normal trainee account.
//
// FORCA (brand: 'forca') trainees are minors: creating one (accountType
// !== 'parent_only') requires parentFirstName/parentPhone/parentEmail, and
// this handler creates-or-reuses a 'parent_only' account for that email and
// links it to the trainee via createFamilyLink — see the FORCA Member
// Creation & Parental Onboarding plan. requireHealthForm/requireRegistrationForm
// are forced true for FORCA trainees regardless of what the caller sent:
// these are mandatory for minors, not an admin-optional toggle. The parent's
// own compliance flags (getProfile.ts) are computed from her own forms/admin
// fields, which start out false — she satisfies the trainee's flags by
// switching into the trainee's profile (switchProfile.ts) and filling them
// there, not by filling anything on her own account.
//
// SECURITY NOTE for whoever reviews this before deploying: AdminCreateUser
// is an IAM-privileged Cognito action — it can create arbitrary accounts
// (including ones with role:'admin' if this handler's own isAdmin() check
// were ever bypassed by a bug). This repo's Lambdas all currently share ONE
// IAM execution role (see lambdas.tf's lambda_dynamodb / lambda_cognito
// policies) — granting this permission technically grants it to all 61
// functions, not just this one. That's the existing pattern (AdminDeleteUser
// was already added the same way for onMemberDeleted.ts), not something new
// introduced here, but worth flagging: the only thing standing between "any
// authenticated caller" and "can create Cognito users" is the isAdmin(uid)
// check below, with zero IAM-level backstop. If this table/pattern ever
// moves toward per-function roles, this is the function that most needs one.
//
// PASSWORD FLOW: uses a real Cognito TemporaryPassword, which puts the new
// user in FORCE_CHANGE_PASSWORD status — Cognito's own "must change temp
// password" enforcement. The client now handles the resulting
// NEW_PASSWORD_REQUIRED challenge on first sign-in (see cognitoAuth.ts's
// signIn()/respondToNewPasswordChallenge() and
// NewPasswordRequiredScreen.tsx) — this used to call AdminSetUserPassword
// with Permanent:true to route around that challenge before that client
// support existed; no longer needed.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    email?: unknown; firstName?: unknown; lastName?: unknown; phone?: unknown;
    birthday?: unknown; age?: unknown; requireHealthForm?: unknown;
    requireRegistrationForm?: unknown; membershipId?: unknown; accountType?: unknown;
    brand?: unknown; parentFirstName?: unknown; parentLastName?: unknown; parentPhone?: unknown; parentEmail?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  if (!email || !firstName) return json(400, { error: 'missing_required_fields' });
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const accountType = body.accountType === 'parent_only' ? 'parent_only' as const : 'member' as const;
  // Registration entry point = whichever brand mode the admin's Backoffice was
  // toggled to when they created this member (see AdminBrandModeContext in
  // incore-app). Anything other than the literal 'forca' defaults to 'incore',
  // same permissive style as accountType above.
  const brand = body.brand === 'forca' ? 'forca' as const : 'incore' as const;
  const isForcaTrainee = brand === 'forca' && accountType !== 'parent_only';

  let parentFirstName = '';
  let parentLastName = '';
  let parentPhone = '';
  let parentEmail = '';
  if (isForcaTrainee) {
    parentFirstName = typeof body.parentFirstName === 'string' ? body.parentFirstName.trim() : '';
    parentLastName = typeof body.parentLastName === 'string' ? body.parentLastName.trim() : '';
    parentPhone = typeof body.parentPhone === 'string' ? body.parentPhone.trim() : '';
    parentEmail = typeof body.parentEmail === 'string' ? body.parentEmail.trim().toLowerCase() : '';
    if (!parentFirstName || !parentPhone || !parentEmail) {
      return json(400, { error: 'missing_parent_details' });
    }
  }
  const parentFullName = [parentFirstName, parentLastName].filter(Boolean).join(' ');

  const requireHealthForm = isForcaTrainee ? true : body.requireHealthForm === true;
  const requireRegistrationForm = isForcaTrainee ? true : body.requireRegistrationForm === true;

  const userPoolId = process.env.COGNITO_USER_POOL_ID as string;
  const cognito = new CognitoIdentityProviderClient({});

  // Resolve the parent account before creating the trainee, so a bad/
  // conflicting parentEmail fails fast without leaving an orphaned trainee
  // Cognito user behind.
  let parentUid: string | undefined;
  if (isForcaTrainee) {
    const existingRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': `EMAIL#${parentEmail}` },
      Limit: 1,
    }));
    const existingParent = existingRes.Items?.[0] as MemberProfileItem | undefined;
    if (existingParent) {
      const identity = existingParent.identity;
      if (identity?.accountType === 'parent_only' && identity?.brand === 'forca') {
        parentUid = (existingParent.PK as string).replace('MEMBER#', '');
      } else {
        return json(409, { error: 'parent_email_conflict' });
      }
    } else {
      const parentCreate = await createMemberAccount({
        email: parentEmail,
        firstName: parentFirstName,
        lastName: parentLastName,
        phone: parentPhone,
        accountType: 'parent_only',
        brand: 'forca',
        requireHealthForm: false,
        requireRegistrationForm: false,
      }, callerUid, cognito, userPoolId);
      if ('error' in parentCreate) return json(parentCreate.status, { error: parentCreate.error });
      parentUid = parentCreate.uid;
      await sendWelcomeEmail(parentEmail, parentFullName, parentCreate.initialPassword).catch((err) => {
        console.error('[adminCreateUser] parent welcome email failed', err);
      });
    }
  }

  const traineeCreate = await createMemberAccount({
    email,
    firstName,
    lastName,
    phone,
    accountType,
    brand,
    requireHealthForm,
    requireRegistrationForm,
    birthday: typeof body.birthday === 'string' ? body.birthday : undefined,
    age: typeof body.age === 'number' ? body.age : undefined,
    membershipId: typeof body.membershipId === 'string' && body.membershipId ? body.membershipId : undefined,
  }, callerUid, cognito, userPoolId);
  if ('error' in traineeCreate) return json(traineeCreate.status, { error: traineeCreate.error });

  await sendWelcomeEmail(email, [firstName, lastName].filter(Boolean).join(' '), traineeCreate.initialPassword).catch((err) => {
    // Non-fatal — the account exists and works even if the email fails.
    console.error('[adminCreateUser] welcome email failed', err);
  });

  if (traineeCreate.pendingMembership) {
    await bridgeTokenToBillingAgreement(traineeCreate.uid);
  }

  if (isForcaTrainee && parentUid) {
    const linkResult = await createFamilyLink(parentUid, traineeCreate.uid, callerUid);
    if (!linkResult.ok) {
      // Both accounts already exist at this point — surface the problem
      // rather than failing the whole request, same non-fatal pattern as
      // the welcome email above.
      await recordSystemAlert({
        severity: 'error',
        source: 'adminCreateUser',
        message: `Failed to link FORCA trainee ${traineeCreate.uid} to parent ${parentUid}: ${linkResult.error}`,
        context: { parentUid, childUid: traineeCreate.uid, error: linkResult.error },
      }).catch(() => {});
    }
  }

  return json(200, { success: true, uid: traineeCreate.uid, ...(parentUid ? { parentUid } : {}) });
}

interface CreateMemberInput {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  accountType: 'member' | 'parent_only';
  brand: 'incore' | 'forca';
  requireHealthForm: boolean;
  requireRegistrationForm: boolean;
  birthday?: string;
  age?: number;
  membershipId?: string;
}

type CreateMemberResult =
  | { uid: string; initialPassword: string; pendingMembership: boolean }
  | { error: string; status: number };

async function createMemberAccount(
  input: CreateMemberInput,
  callerUid: string,
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
): Promise<CreateMemberResult> {
  const name = [input.firstName, input.lastName].filter(Boolean).join(' ');
  const initialPassword = generateInitialPassword();

  let uid: string;
  try {
    const createRes = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: input.email,
      TemporaryPassword: initialPassword,
      MessageAction: 'SUPPRESS', // custom welcome email sent by the caller instead of Cognito's default
      UserAttributes: [
        { Name: 'email', Value: input.email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
    }));
    const subAttr = createRes.User?.Attributes?.find((a) => a.Name === 'sub');
    if (!subAttr?.Value) throw new Error('Cognito did not return a sub for the new user');
    uid = subAttr.Value;
  } catch (err: any) {
    if (err?.name === 'UsernameExistsException') return { error: 'email_already_exists', status: 409 };
    console.error('[adminCreateUser] Cognito error', err);
    return { error: 'cognito_create_failed', status: 500 };
  }

  const profileItem: Record<string, unknown> = {
    PK: `MEMBER#${uid}`,
    SK: 'PROFILE',
    GSI3PK: `EMAIL#${input.email}`,
    GSI3SK: `MEMBER#${uid}`,
    identity: {
      name,
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      phone: input.phone,
      role: 'member',
      accountType: input.accountType,
      brand: input.brand,
      ...(input.birthday ? { birthday: input.birthday } : {}),
      ...(input.age != null ? { age: input.age } : {}),
    },
    admin: {
      require_health_form: input.requireHealthForm,
      require_registration_form: input.requireRegistrationForm,
    },
    createdAt: new Date().toISOString(),
    createdBy: callerUid,
  };
  if (input.membershipId) {
    profileItem.pending_membership = { type: input.membershipId };
  }

  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: profileItem }));
  } catch (err: any) {
    // Roll back the Cognito user if the profile write fails, so Cognito and
    // DynamoDB never end up out of sync (same rationale as the old Firebase
    // useCreateMember.ts's rollback-on-failure behavior).
    console.error('[adminCreateUser] DynamoDB write failed, rolling back Cognito user', err);
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: input.email }));
    } catch (rollbackErr) {
      console.error('[adminCreateUser] rollback also failed — manual cleanup needed for', input.email, rollbackErr);
    }
    return { error: 'profile_write_failed', status: 500 };
  }

  return { uid, initialPassword, pendingMembership: !!input.membershipId };
}

function generateInitialPassword(): string {
  // Cognito's password policy (cognito.tf) is numeric-only, min length 6 —
  // matches the old Firebase flow's 7-digit-numeric temp password.
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const IOS_APP_URL     = 'https://apps.apple.com/il/app/incore-studio/id6771026998';
const ANDROID_APP_URL = 'https://play.google.com/store/apps/details?id=com.workout.incore';
// Hosted under the incore-production-uploads bucket's email-assets/ prefix —
// the one deliberate public-read exception on an otherwise fully private
// bucket (see s3.tf) — email clients fetch embedded images unauthenticated,
// so a presigned URL isn't an option here.
const APP_STORE_BADGE_URL   = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/appstore.png';
const GOOGLE_PLAY_BADGE_URL = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/googleplay.png';
const STUDIO_LOGO_URL       = 'https://incore-production-uploads.s3.eu-central-1.amazonaws.com/email-assets/Logo.png';

async function sendWelcomeEmail(email: string, name: string, password: string): Promise<void> {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'incoreworkout@gmail.com', pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: '"INCORE" <incoreworkout@gmail.com>',
    to: email,
    subject: 'ברוך הבא ל-INCORE! פרטי ההתחברות שלך בפנים',
    html: `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#f4f7f9;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;direction:rtl;">
  <div style="max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,0.05);">
    <div style="padding:24px 30px;text-align:center;border-bottom:1px solid #eeeeee;">
      <img src="${STUDIO_LOGO_URL}" alt="INCORE" height="48" style="height:48px;width:auto;border:0;">
    </div>
    <div style="padding:40px 30px;color:#333333;line-height:1.6;text-align:right;">
      <h2 style="color:#2c3e50;margin-top:0;">שלום ${name},</h2>
      <p style="margin:0 0 16px 0;">איזה כיף לראות אותך איתנו! אנחנו נרגשים שהצטרפת לאפליקציה שלנו.</p>
      <p>החשבון שלך הוגדר בהצלחה. להלן פרטי ההתחברות האישיים שלך:</p>
      <div style="background-color:#f8f9fa;border-right:4px solid #5C3A8F;padding:20px;margin:25px 0;border-radius:4px;">
        <p style="margin:0 0 10px 0;"><strong>שם משתמש:</strong> <a href="mailto:${email}" style="color:#5C3A8F;">${email}</a></p>
        <p style="margin:0;"><strong>סיסמה זמנית:</strong> <span style="color:#5C3A8F;font-weight:bold;">${password}</span></p>
      </div>
      <p style="font-size:0.9em;color:#666;">* ליתר ביטחון, אנו ממליצים להחליף את הסיסמה הזמנית לאחר הכניסה הראשונה.</p>
    </div>
    <div style="background-color:#f4f2fa;padding:30px;text-align:center;">
      <p style="margin:0 0 6px 0;font-size:17px;font-weight:700;color:#5C3A8F;">הורד את האפליקציה עכשיו</p>
      <p style="margin:0 0 20px 0;font-size:13px;color:#666;">זמין ל-iPhone וגם לאנדרואיד</p>
      <a href="${ANDROID_APP_URL}" style="display:inline-block;margin:0 6px;" target="_blank" rel="noopener noreferrer">
        <img src="${GOOGLE_PLAY_BADGE_URL}" alt="הורד מ-Google Play" height="48" style="height:48px;width:auto;border:0;">
      </a>
      <a href="${IOS_APP_URL}" style="display:inline-block;margin:0 6px;" target="_blank" rel="noopener noreferrer">
        <img src="${APP_STORE_BADGE_URL}" alt="הורד מה-App Store" height="48" style="height:48px;width:auto;border:0;">
      </a>
    </div>
  </div>
</body></html>`,
  });
}
