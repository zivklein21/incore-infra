import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

const FILE_URL_EXPIRY_SECONDS = 900;

function presign(key: string | undefined): Promise<string | null> {
  if (!key) return Promise.resolve(null);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: FILE_URL_EXPIRY_SECONDS }).catch(() => null);
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

function deriveFirstLastName(p: MemberProfileItem): { firstName: string; lastName: string } {
  const first = p.identity?.first_name ?? '';
  const last = p.identity?.last_name ?? '';
  if (first || last) return { firstName: first, lastName: last };
  const combined = p.identity?.name || p.identity?.full_name || p.name || '';
  const parts = combined.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

// GET or POST /getMemberDetail?memberId=xxx
// Auth: Cognito JWT, caller must be admin
//
// membershipStatus/membershipTypeId/membershipStart/membershipEnd/
// monthlyLateCancellations/monthlyValidCancellations mirror the legacy V1
// membership fields the old Firestore version read (member.membership.*,
// member.classes.monthly_penalties/cancellations) — MemberDetailsScreen's
// actual membership card now reads useActiveMembershipV2 (a real V2
// MembershipItem) instead, so these are display-fallback-only; kept for
// type compatibility but not deeply computed.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const memberId = event.queryStringParameters?.memberId;
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  const p = res.Item as MemberProfileItem | undefined;
  if (!p) return json(200, null);

  const forms = p.forms ?? {};
  const membership = p.membership ?? {};
  const hd = forms.health_declaration;
  const pc = forms.parental_consent;

  const [pdfUrl, doctorApprovalUrl, signatureUrl] = await Promise.all([
    presign(hd?.pdf_key),
    presign(hd?.doctor_approval_key),
    presign(pc?.signatureKey),
  ]);

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const healthDeclaration = hd?.submitted_at ? { submitted_at: hd.submitted_at, pdf_url: pdfUrl ?? undefined } : null;
  const healthDeclarationValid = !!healthDeclaration && !!pdfUrl && new Date(hd!.submitted_at!) >= twoYearsAgo;

  const registrationAnswers = forms.registration_answers ?? null;
  const { firstName, lastName } = deriveFirstLastName(p);
  const birthday = p.identity?.birthday ?? p.birthday ?? null;
  const age = computeAge(birthday ?? undefined);

  const parentalConsent = pc?.isApproved ? {
    parentName: pc.parentName ?? '',
    parentPhone: pc.parentPhone ?? '',
    parentEmail: pc.parentEmail ?? '',
    signatureUrl: signatureUrl ?? '',
    signaturePaths: pc.signaturePaths ?? [],
    signedAt: pc.signedAt ? pc.signedAt.split('T')[0] : '',
    expiresAt: pc.expiresAt ? pc.expiresAt.split('T')[0] : '',
    isExpired: !pc.expiresAt || new Date(pc.expiresAt) <= new Date(),
    photoConsent: pc.photoConsent === true,
  } : null;

  const photoConsent: boolean | null =
    age !== null && age < 18 ? null : (forms.photo_consent === true ? true : forms.photo_consent === false ? false : null);

  const status = membership.status;
  const membershipStatus =
    status === 'expiring' || status === 'expired' || status === 'prorated_pending' || status === 'prorated' ? status : 'active';

  return json(200, {
    id: memberId,
    name: p.identity?.name || p.identity?.full_name || [firstName, lastName].filter(Boolean).join(' ') || p.name || 'Unknown',
    firstName, lastName,
    subtitle: typeof membership.plan === 'string' ? membership.plan : '',
    membershipStatus,
    monthlyLateCancellations: 0,
    monthlyValidCancellations: 0,
    membershipTypeId: typeof membership.type === 'string' ? membership.type : null,
    membershipStart: typeof membership.start === 'string' ? membership.start : null,
    membershipEnd: typeof membership.end === 'string' ? membership.end : null,
    age, birthday,
    photoUrl: await presign(p.photoKey),
    phone: p.identity?.phone ?? p.phone ?? '',
    email: p.identity?.email ?? p.email ?? '',
    role: p.identity?.role ?? p.role ?? 'member',
    adminAlertMessage: p.admin?.alertMessage ?? '',
    healthDeclaration,
    healthDeclarationValid,
    registrationForm: forms.registration_form === true && registrationAnswers !== null && Object.keys(registrationAnswers).length > 0,
    registrationAnswers,
    agreedToPolicies: forms.agreedToPolicies === true,
    policiesAcceptedAt: forms.policiesAcceptedAt ?? null,
    parentalConsent,
    photoConsent,
    // The product a member is assigned to move onto (e.g. after a manually-
    // created CUSTOM_MIGRATION bridge membership expires) — that bridge
    // record itself carries no price, so MemberDetailsScreen needs this to
    // show what they'll actually be charged next, same as getProfile.ts
    // already exposes to the member's own profile screen.
    pendingMembershipTypeId: p.pending_membership?.type ?? null,
  });
}
