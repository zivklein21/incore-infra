import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem, MembershipItem } from '../lib/entities';

const FILE_URL_EXPIRY_SECONDS = 900;

function presign(key: string | undefined): Promise<string | null> {
  if (!key) return Promise.resolve(null);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: FILE_URL_EXPIRY_SECONDS });
}

function computeAge(birthday: string | number | undefined): number | null {
  if (birthday == null) return null;
  const d = new Date(birthday);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const beforeBirthdayThisYear = now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

// GET or POST /getProfile?memberId=xxx
// Auth: Cognito JWT. Defaults to the caller's own profile; passing a
// different memberId requires the caller to be admin (same pattern as
// getWallet.ts).
//
// requiresRegistrationForm / requiresHealthDeclaration / requiresPoliciesAgreement
// are now computed for real from forms.* (see submitRegistrationForm.ts /
// submitHealthDeclaration.ts / acceptPolicies.ts, which write those fields)
// and admin.require_health_form / admin.require_registration_form (set at
// account-creation time by adminCreateUser.ts) — same logic the old
// Firebase useAuth.ts's buildAuthUser used.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const requestedMemberId = event.queryStringParameters?.memberId;
  const memberId = requestedMemberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) {
    return json(403, { error: 'forbidden' });
  }

  const [profileRes, membershipsRes] = await Promise.all([
    ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE' },
    })),
  ]);

  const profile = profileRes.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const memberships = (membershipsRes.Items ?? []) as MembershipItem[];
  const activeMembership = memberships[0] ?? null;

  const role = profile.identity?.role ?? profile.role ?? 'member';
  const name = profile.identity?.name
    || [profile.identity?.first_name, profile.identity?.last_name].filter(Boolean).join(' ')
    || profile.name
    || '';

  const forms = profile.forms ?? {};
  const admin = profile.admin ?? {};

  const registrationAnswers = forms.registration_answers;
  // forms.registration_form is the atomic "member completed this step" flag
  // submitRegistrationForm.ts sets — trust it alone. Additionally requiring
  // a non-empty registration_answers object broke completion whenever the
  // configured form has zero questions (submits as {}), leaving members
  // stuck being routed back to a form that already succeeded.
  const registrationFormFilled = forms.registration_form === true;
  const requiresRegistrationForm = admin.require_registration_form === true && !registrationFormFilled;

  const hdSubmittedAt = forms.health_declaration?.submitted_at;
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const requiresHealthDeclaration = role !== 'admin' && admin.require_health_form === true
    && (!hdSubmittedAt || new Date(hdSubmittedAt) < twoYearsAgo);

  const requiresPoliciesAgreement = role !== 'admin' && forms.agreedToPolicies !== true;

  const birthday = profile.identity?.birthday ?? profile.birthday ?? null;
  const age = computeAge(birthday ?? undefined);

  const [photoUrl, healthPdfUrl, doctorApprovalUrl] = await Promise.all([
    presign(profile.photoKey),
    presign(forms.health_declaration?.pdf_key),
    presign(forms.health_declaration?.doctor_approval_key),
  ]);

  const healthDeclaration = forms.health_declaration?.submitted_at
    ? { submitted_at: forms.health_declaration.submitted_at, pdf_url: healthPdfUrl ?? undefined, doctor_approval_url: doctorApprovalUrl ?? undefined }
    : null;
  const healthDeclarationValid = !!healthDeclaration && !requiresHealthDeclaration;

  const pc = forms.parental_consent;
  const parentalConsent = pc?.isApproved
    ? {
        isApproved: true,
        expiresAt: pc.expiresAt ? pc.expiresAt.split('T')[0] : '',
        isExpired: !pc.expiresAt || new Date(pc.expiresAt) <= new Date(),
        parentName: pc.parentName ?? '',
        parentPhone: pc.parentPhone ?? '',
        parentEmail: pc.parentEmail ?? '',
        signedAt: pc.signedAt ? pc.signedAt.split('T')[0] : '',
        signaturePaths: pc.signaturePaths ?? [],
        photoConsent: pc.photoConsent === true,
      }
    : null;

  const photoConsent: boolean | null =
    age !== null && age < 18
      ? (pc?.photoConsent === true ? true : pc?.photoConsent === false ? false : null)
      : (forms.photo_consent === true ? true : forms.photo_consent === false ? false : null);

  return json(200, {
    id: memberId,
    email: profile.identity?.email ?? profile.email ?? '',
    name,
    phone: profile.identity?.phone ?? profile.phone ?? '',
    birthday,
    age,
    photoUrl,
    role,
    isAdmin: role === 'admin',
    // Family Accounts: 'parent_only' — created solely to hold family links,
    // no membership/booking of their own (adminCreateUser.ts). Undefined/
    // 'member' is a normal trainee account.
    accountType: profile.identity?.accountType ?? 'member',
    hasMembership: !!activeMembership,
    membershipType: activeMembership?.type ?? null,
    membershipStatus: activeMembership?.status ?? null,
    requiresRegistrationForm,
    requiresHealthDeclaration,
    requiresPoliciesAgreement,
    healthDeclaration,
    healthDeclarationValid,
    registrationForm: registrationFormFilled,
    registrationAnswers: registrationAnswers ?? null,
    agreedToPolicies: forms.agreedToPolicies === true,
    policiesAcceptedAt: forms.policiesAcceptedAt ?? null,
    parentalConsent,
    photoConsent,
    pendingMembershipType: profile.pending_membership?.type ?? null,
    adminAlertMessage: profile.admin?.hasUnreadAlert !== false ? (profile.admin?.alertMessage ?? null) : null,
    payment: {
      hasSavedCard: profile.payment?.hasSavedCard === true,
      hypTokenExpiryMonth: profile.payment?.hypTokenExpiryMonth ?? null,
      hypTokenExpiryYear: profile.payment?.hypTokenExpiryYear ?? null,
      hypTokenLast4: profile.payment?.hypToken && profile.payment.hypToken.length >= 4
        ? profile.payment.hypToken.slice(-4) : null,
      cardBrand: profile.payment?.cardBrand ?? null,
    },
  });
}
