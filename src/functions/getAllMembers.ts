import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getAllMemberProfiles } from '../lib/memberScan';
import { s3, BUCKET_NAME } from '../lib/s3';
import type { MemberProfileItem } from '../lib/entities';

const PHOTO_URL_EXPIRY_SECONDS = 900;

function deriveName(p: MemberProfileItem): string {
  return p.identity?.name
    || p.identity?.full_name
    || [p.identity?.first_name, p.identity?.last_name].filter(Boolean).join(' ')
    || p.name
    || 'Unknown';
}

function deriveStatus(val: unknown): 'active' | 'expiring' | 'expired' {
  return val === 'expiring' || val === 'expired' ? val : 'active';
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

// GET or POST /getAllMembers
// Auth: Cognito JWT, caller must be admin
// Full-table scan via getAllMemberProfiles() — same documented <=50-user
// scale tradeoff already accepted by every other admin-scan caller
// (birthday rewards, membership reminders, template broadcasts).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const profiles = await getAllMemberProfiles();

  const members = await Promise.all(profiles
    .filter((p) => (p.identity?.role ?? p.role) !== 'admin')
    .map(async (p) => {
      const id = p.PK.replace('MEMBER#', '');
      const birthday = p.identity?.birthday ?? p.birthday ?? null;
      const forms = p.forms ?? {};
      const hd = forms.health_declaration;
      const pc = forms.parental_consent;

      const presign = async (key: string | undefined) => {
        if (!key) return null;
        try {
          return await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: PHOTO_URL_EXPIRY_SECONDS });
        } catch { return null; }
      };
      const [photoUrl, pdfUrl, doctorApprovalUrl] = await Promise.all([
        presign(p.photoKey),
        presign(hd?.pdf_key),
        presign(hd?.doctor_approval_key),
      ]);

      return {
        id,
        name: deriveName(p),
        email: p.identity?.email ?? p.email ?? '',
        phone: p.identity?.phone ?? p.phone ?? '',
        subtitle: typeof p.membership?.plan === 'string' ? p.membership.plan : '',
        membershipStatus: deriveStatus(p.membership?.status),
        membershipType: typeof p.membership?.type === 'string' ? p.membership.type : null,
        healthForm: forms.health_form === true,
        healthDeclaration: hd?.submitted_at
          ? { submitted_at: hd.submitted_at, pdf_url: pdfUrl ?? undefined, doctor_approval_url: doctorApprovalUrl ?? undefined, answers: hd.answers ?? {} }
          : null,
        registrationForm: forms.registration_form === true
          && typeof forms.registration_answers === 'object' && forms.registration_answers !== null
          && Object.keys(forms.registration_answers).length > 0,
        agreedToPolicies: forms.agreedToPolicies === true,
        role: p.identity?.role ?? p.role ?? 'member',
        brand: p.identity?.brand ?? 'incore',
        age: computeAge(birthday ?? undefined),
        birthday,
        photoUrl,
        parentalConsentValid: !!pc?.isApproved && !!pc.expiresAt && new Date(pc.expiresAt) > new Date(),
      };
    }));

  members.sort((a, b) => a.name.localeCompare(b.name));
  return json(200, { members });
}
