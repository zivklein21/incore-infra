import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getAllMemberProfiles } from '../lib/memberScan';
import { ddb, tableForBrand } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import type { MemberProfileItem } from '../lib/entities';
import { allConsentStatuses } from '../lib/photoConsent/store';
import { forcaRowLabel, legacyPlanLabel, loadForcaGroupNames, planLabelsFor, scanAllPlanItems } from '../lib/memberPlanLabel';

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

// GET or POST /getAllMembers?brand=incore|forca
// Auth: Cognito JWT, caller must be admin
// Full-table scan via getAllMemberProfiles() — same documented <=50-user
// scale tradeoff already accepted by every other admin-scan caller
// (birthday rewards, membership reminders, template broadcasts).
//
// brand picks which table to scan — the table itself is the brand filter
// now (see the FORCA data separation plan), so this only ever returns one
// brand's members per call. Defaults to 'incore' for callers that don't
// pass it yet.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;
  const profiles = await getAllMemberProfiles(tableForBrand(brand));
  // Best effort: a failure here shouldn't take the member list down with it.
  const consents = brand !== 'forca' ? null : await allConsentStatuses().catch((err) => {
    console.error('[getAllMembers] photo consent lookup failed', err);
    return null;
  });

  // The row label (plan name for INCORE, group for FORCA), resolved here so
  // the list needs no per-member calls — see lib/memberPlanLabel.ts.
  const now = new Date();
  // Best effort, like the consents above: without it rows fall back to ''.
  const empty = (err: unknown) => { console.error('[getAllMembers] row label lookup failed', err); return new Map<string, string>(); };
  const [planLabels, groupNames] = await Promise.all([
    brand === 'incore' ? scanAllPlanItems().then((items) => planLabelsFor(items, now)).catch(empty) : Promise.resolve(new Map<string, string>()),
    brand === 'forca' ? loadForcaGroupNames().catch(empty) : Promise.resolve(new Map<string, string>()),
  ]);

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
      // FORCA trainee (not parent_only, not a coach) — surfaces whether she
      // still needs connecting to a parent via Manage > Family Links
      // (adminLinkFamilyMember.ts), the case adminCreateUser.ts's
      // linkParentLater option deliberately leaves unlinked. Checked the
      // same way createFamilyLink.ts already checks "is this child already
      // linked" — GSI1PK=MEMBER#<id>, GSI1SK begins_with FAMILYOF#.
      const accountType = p.identity?.accountType ?? 'member';
      const role = p.identity?.role ?? p.role ?? 'member';
      const isForcaTraineeRow = brand === 'forca' && accountType !== 'parent_only' && role !== 'coach';

      const [photoUrl, pdfUrl, doctorApprovalUrl, familyLinkRes] = await Promise.all([
        presign(p.photoKey),
        presign(hd?.pdf_key),
        presign(hd?.doctor_approval_key),
        isForcaTraineeRow
          ? ddb.send(new QueryCommand({
              TableName: tableForBrand(brand),
              IndexName: 'GSI1',
              KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
              ExpressionAttributeValues: { ':pk': `MEMBER#${id}`, ':prefix': 'FAMILYOF#' },
              Limit: 1,
            }))
          : Promise.resolve(null),
      ]);
      const hasParentLinked = isForcaTraineeRow ? (familyLinkRes?.Items?.length ?? 0) > 0 : null;

      return {
        id,
        accountType,
        isTest: p.isTest === true,
        hasParentLinked,
        name: deriveName(p),
        email: p.identity?.email ?? p.email ?? '',
        phone: p.identity?.phone ?? p.phone ?? '',
        // INCORE: the current plan ('' = really none; the app shows "No
        // active plan"). FORCA: the trainee's group. The legacy
        // profile.membership.plan is only a last resort for INCORE (an
        // admin badge override, adminUpdateMemberMembershipBadge.ts).
        subtitle: brand === 'forca'
          ? forcaRowLabel({ role, accountType, groupId: p.identity?.groupId ?? null, groupIds: p.identity?.groupIds ?? [] }, groupNames)
          : (planLabels.get(id) || legacyPlanLabel(p.membership, now)),
        planName: brand === 'incore' ? (planLabels.get(id) || null) : null,
        groupName: brand === 'forca' && p.identity?.groupId ? (groupNames.get(p.identity.groupId) ?? null) : null,
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
        groupId: p.identity?.groupId ?? null,
        groupIds: p.identity?.groupIds ?? [],
        coachPermissions: p.identity?.coachPermissions ?? null,
        age: computeAge(birthday ?? undefined),
        birthday,
        photoUrl,
        parentalConsentValid: !!pc?.isApproved && !!pc.expiresAt && new Date(pc.expiresAt) > new Date(),
        photoConsentStatus: isForcaTraineeRow && consents ? (consents.get(id) ?? 'not_approved') : null,
      };
    }));

  members.sort((a, b) => a.name.localeCompare(b.name));
  return json(200, { members });
}
