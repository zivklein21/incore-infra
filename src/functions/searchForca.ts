import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getAllMemberProfiles } from '../lib/memberScan';
import { deriveMemberName, type GroupItem, type MemberProfileItem, type WorkoutPlanItem } from '../lib/entities';

const MAX_RESULTS_PER_CATEGORY = 8;

// Ranks a substring match: an exact prefix match outranks a mid-string
// match, both outrank no match (excluded by the caller before this ever
// runs). Ties keep whatever order they arrived in (each source list is
// already name-sorted).
function matchRank(haystack: string, q: string): number {
  const h = haystack.toLowerCase();
  if (!h.includes(q)) return -1;
  return h.startsWith(q) ? 0 : 1;
}

// GET or POST /searchForca?q=...
// Auth: Cognito JWT, admin-only — same gate as the Manage hub screens this
// powers (GroupsManageScreen.tsx, WorkoutPlansManageScreen.tsx,
// MemberDetailsScreen.tsx), reached from this app's FORCA "Global Search"
// Manage-hub tile. One aggregating endpoint over three otherwise-separate
// admin list screens (getAllMembers.ts / adminListGroups.ts /
// adminListWorkoutPlans.ts) — reuses their exact same Scan/FilterExpression
// conventions rather than inventing new ones, since none of these tables
// are large enough (documented <=50 users/brand elsewhere) to need real
// search infra; this just does the substring match server-side in one
// round-trip instead of the client fetching three separate full lists.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let q = event.queryStringParameters?.q ?? '';
  if (!q && event.body) {
    try {
      const body = JSON.parse(event.body) as { q?: unknown };
      q = typeof body.q === 'string' ? body.q : '';
    } catch { /* ignore */ }
  }
  q = q.trim().toLowerCase();
  if (!q) return json(200, { trainees: [], groups: [], workoutPlans: [] });

  const [profiles, groupsRes, plansRes] = await Promise.all([
    getAllMemberProfiles(FORCA_TABLE_NAME),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'WORKOUTPLAN#', ':metadata': 'METADATA' },
    })),
  ]);

  // Trainees only — same "kids program, not coach/admin/parent_only"
  // convention as ForcaTrackerScreen.tsx's roster picker.
  const trainees = (profiles as MemberProfileItem[])
    .filter((p) => {
      const role = p.identity?.role ?? p.role;
      return role !== 'admin' && role !== 'coach' && p.identity?.accountType !== 'parent_only';
    })
    .map((p) => {
      const name = deriveMemberName(p);
      const phone = p.identity?.phone ?? '';
      const nameRank = matchRank(name, q); // -1 no match, 0 prefix, 1 substring
      const phoneRank = phone.includes(q) ? 1 : -1;
      const rank = nameRank === -1 ? phoneRank : phoneRank === -1 ? nameRank : Math.min(nameRank, phoneRank);
      return { id: (p.PK as string).replace('MEMBER#', ''), name, phone, groupId: p.identity?.groupId ?? null, rank };
    })
    .filter((t) => t.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map(({ id, name, phone, groupId }) => ({ id, name, phone, groupId }));

  const groups = ((groupsRes.Items ?? []) as (GroupItem & { PK: string })[])
    .map((g) => ({ id: g.PK.replace('GROUP#', ''), name: g.name ?? '', rank: matchRank(g.name ?? '', q) }))
    .filter((g) => g.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map(({ id, name }) => ({ id, name }));

  const workoutPlans = ((plansRes.Items ?? []) as (WorkoutPlanItem & { PK: string })[])
    .map((p) => ({ id: p.PK.replace('WORKOUTPLAN#', ''), name: p.name ?? '', active: p.active, rank: matchRank(p.name ?? '', q) }))
    .filter((p) => p.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map(({ id, name, active }) => ({ id, name, active }));

  return json(200, { trainees, groups, workoutPlans });
}
