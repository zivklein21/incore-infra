import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { getAllMemberProfiles } from '../lib/memberScan';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import type { GroupItem, MemberProfileItem } from '../lib/entities';

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
// full profile/health-declaration/photo payload) scoped to her assigned
// groups (empty groupIds, the deny-by-default case, returns nothing).
//
// ?scope=all includes every age (Coach Role epic, item 7's Trainee
// Management — "her own trainees" generally), plus a groupName, age, and
// medicalFlag per trainee (own-profile "details + medical status" view —
// same coarse boolean-flag-not-clinical-detail convention as
// sessionDetail.ts's roster medicalFlag: true iff any health declaration
// answer is 'yes'; gated by healthDeclarations !== 'none' same as there).
// Default (or any other/missing value) keeps the original under-18-only,
// id/name/phone-only behavior, matching ForcaTrackerScreen.tsx's admin
// picker — FORCA's Tracker is scoped to the kids program even though the
// brand has adult members too; only the Settings hub's management list
// needs everyone/the extra fields.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  const allAges = event.queryStringParameters?.scope === 'all';

  const [profiles, groupsRes] = await Promise.all([
    getAllMemberProfiles(FORCA_TABLE_NAME),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
    })),
  ]);
  const groupNameById = new Map(
    ((groupsRes.Items ?? []) as GroupItem[]).map((g) => [g.PK.replace('GROUP#', ''), g.name ?? '']),
  );

  const trainees = profiles
    .filter((p) => {
      const role = p.identity?.role ?? p.role;
      if (role === 'admin' || role === 'coach') return false;
      if (!groupInAccess(access, p.identity?.groupId)) return false;
      if (allAges) return true;
      const age = computeAge(p.identity?.birthday ?? p.birthday ?? undefined);
      return age !== null && age < 18;
    })
    .map((p) => {
      const healthAnswers = p.forms?.health_declaration?.answers ?? {};
      return {
        id: p.PK.replace('MEMBER#', ''),
        name: deriveName(p),
        phone: p.identity?.phone ?? p.phone ?? '',
        groupName: groupNameById.get(p.identity?.groupId ?? '') ?? null,
        age: allAges ? computeAge(p.identity?.birthday ?? p.birthday ?? undefined) : null,
        medicalFlag: allAges && access.permissions.healthDeclarations !== 'none'
          ? Object.values(healthAnswers).some((v) => v === 'yes')
          : false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { trainees });
}
