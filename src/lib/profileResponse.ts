import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb } from './dynamo';
import { resolveMemberProfile } from './memberLookup';
import { s3, BUCKET_NAME } from './s3';
import { computeComplianceFlags, type GroupItem, type MembershipItem } from './entities';

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

// Extracted out of getProfile.ts so getChildProfile.ts (the FORCA Child
// Switcher's parent-session, no-identity-switch profile read — see
// verifyFamilyLink in familyLinks.ts) can return the exact same shape
// without duplicating every presign/compliance-flag/group-lookup computation.
// Callers own their own authorization check before calling this — this
// function itself doesn't check who's asking, only resolves memberId's data.
export async function buildProfileResponse(memberId: string): Promise<Record<string, unknown> | null> {
  const resolved = await resolveMemberProfile(memberId);
  if (!resolved) return null;
  const { table, profile } = resolved;

  const membershipsRes = await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE' },
  }));

  const memberships = (membershipsRes.Items ?? []) as MembershipItem[];
  const activeMembership = memberships[0] ?? null;

  const role = profile.identity?.role ?? profile.role ?? 'member';
  const name = profile.identity?.name
    || [profile.identity?.first_name, profile.identity?.last_name].filter(Boolean).join(' ')
    || profile.name
    || '';

  const forms = profile.forms ?? {};

  const registrationAnswers = forms.registration_answers;
  // forms.registration_form is the atomic "member completed this step" flag
  // submitRegistrationForm.ts sets — trust it alone. Additionally requiring
  // a non-empty registration_answers object broke completion whenever the
  // configured form has zero questions (submits as {}), leaving members
  // stuck being routed back to a form that already succeeded.
  const registrationFormFilled = forms.registration_form === true;
  const { requiresRegistrationForm, requiresHealthDeclaration, requiresPoliciesAgreement, requiresParentalAuthorization } = computeComplianceFlags(profile);

  const birthday = profile.identity?.birthday ?? profile.birthday ?? null;
  const age = computeAge(birthday ?? undefined);

  const brand = profile.identity?.brand ?? 'incore';
  const groupId = brand === 'forca' ? profile.identity?.groupId : undefined;

  const [photoUrl, healthPdfUrl, doctorApprovalUrl, medicalClearanceUrl, groupRes] = await Promise.all([
    presign(profile.photoKey),
    presign(forms.health_declaration?.pdf_key),
    presign(forms.health_declaration?.doctor_approval_key),
    presign(forms.medical_clearance_key),
    groupId ? ddb.send(new GetCommand({ TableName: table, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } })) : Promise.resolve(null),
  ]);
  const group = groupRes?.Item as GroupItem | undefined;
  const groupName = group?.name ?? null;
  // FORCA has no recurring billing agreement (see GroupItem's doc comment —
  // a Group doubles as the membership plan), so there's no concrete next-
  // charge date to show. GroupItem.price is the closest real "next payment"
  // signal the Overview tab has — the recurring amount for her group, when
  // the admin has set one.
  const groupPrice = typeof group?.price === 'number' ? group.price : null;

  const medicalClearance = {
    requested: forms.medical_clearance_requested === true,
    requestedAt: forms.medical_clearance_requested_at ?? null,
    uploadedAt: forms.medical_clearance_uploaded_at ?? null,
    url: medicalClearanceUrl,
  };

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

  return {
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
    brand: profile.identity?.brand ?? 'incore',
    hasMembership: !!activeMembership,
    membershipType: activeMembership?.type ?? null,
    membershipStatus: activeMembership?.status ?? null,
    // FORCA has no per-trainee membership-plan record the way INCORE does
    // (a GroupItem doubles as the plan, see entities.ts) — groupName/
    // membershipStart/membershipEnd are the FORCA Overview tab's "activity
    // validity" fields, same raw profile.membership.* fallback fields
    // getMemberDetail.ts already trusts cross-brand rather than new modeling.
    groupName,
    groupPrice,
    membershipStart: typeof profile.membership?.start === 'string' ? profile.membership.start : null,
    membershipEnd: typeof profile.membership?.end === 'string' ? profile.membership.end : null,
    medicalClearance,
    requiresRegistrationForm,
    requiresHealthDeclaration,
    requiresPoliciesAgreement,
    requiresParentalAuthorization,
    healthDeclaration,
    healthDeclarationValid,
    registrationForm: registrationFormFilled,
    registrationAnswers: registrationAnswers ?? null,
    agreedToPolicies: forms.agreedToPolicies === true,
    policiesAcceptedAt: forms.policiesAcceptedAt ?? null,
    parentalConsent,
    photoConsent,
    parentalAuthorization: forms.parental_authorization?.submitted_at
      ? {
          submittedAt: forms.parental_authorization.submitted_at,
          parentName: forms.parental_authorization.parentName ?? '',
          parentPhone: forms.parental_authorization.parentPhone ?? '',
          parentEmail: forms.parental_authorization.parentEmail ?? '',
        }
      : null,
    pendingMembershipType: profile.pending_membership?.type ?? null,
    adminAlertMessage: profile.admin?.hasUnreadAlert !== false ? (profile.admin?.alertMessage ?? null) : null,
    // Admin's manual "pay now" override (adminSetForceShowPaymentButton.ts)
    // — previously admin-only visibility (getMemberDetail.ts). A FORCA
    // trainee never pays for herself (her parent manages payments — see
    // the FORCA Child Switcher plan), so this needs to reach the PARENT's
    // view of her via getChildProfile.ts, not just the trainee's own.
    forceShowPaymentButton: profile.admin?.forceShowPaymentButton === true,
    payment: {
      hasSavedCard: profile.payment?.hasSavedCard === true,
      hypTokenExpiryMonth: profile.payment?.hypTokenExpiryMonth ?? null,
      hypTokenExpiryYear: profile.payment?.hypTokenExpiryYear ?? null,
      hypTokenLast4: profile.payment?.hypToken && profile.payment.hypToken.length >= 4
        ? profile.payment.hypToken.slice(-4) : null,
      cardBrand: profile.payment?.cardBrand ?? null,
    },
  };
}
