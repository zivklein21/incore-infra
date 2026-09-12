import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { getAllMemberProfiles } from '../lib/memberScan';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import type { MemberProfileItem } from '../lib/entities';

function deriveName(p: MemberProfileItem): string {
  return p.identity?.name
    || p.identity?.full_name
    || [p.identity?.first_name, p.identity?.last_name].filter(Boolean).join(' ')
    || p.name
    || 'Unknown';
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

// GET or POST /getCoachTrainees
// Auth: Cognito JWT, admin or a coach with performance:'read' — a coach's
// own minimal trainee roster (id/name/phone only, none of getAllMembers.ts's
// full profile/health-declaration/photo payload) for the Tracker picker in
// CoachTrackingScreen.tsx. Scoped to her assigned groups (empty groupIds,
// the deny-by-default case, returns nothing) and, matching
// ForcaTrackerScreen.tsx's admin picker, to under-18 trainees only — FORCA's
// Tracker is scoped to the kids program even though the brand has adult
// members too.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  const profiles = await getAllMemberProfiles(FORCA_TABLE_NAME);

  const trainees = profiles
    .filter((p) => {
      const role = p.identity?.role ?? p.role;
      if (role === 'admin' || role === 'coach') return false;
      if (!groupInAccess(access, p.identity?.groupId)) return false;
      const age = computeAge(p.identity?.birthday ?? p.birthday ?? undefined);
      return age !== null && age < 18;
    })
    .map((p) => ({
      id: p.PK.replace('MEMBER#', ''),
      name: deriveName(p),
      phone: p.identity?.phone ?? p.phone ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { trainees });
}
