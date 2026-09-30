import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import { resolveMemberWeeklyTaskHistory } from '../lib/weeklyTaskHistory';

// GET or POST /getMemberWeeklyTaskHistory?memberId=...
// Auth: Cognito JWT, admin or a coach with performance:'read' — same gating
// as getMemberExerciseHistory.ts, since this is the same Tracker dashboard,
// just its Weekly Tasks section. A coach only sees trainees in one of her
// assigned groups.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  const memberId = event.queryStringParameters?.memberId
    ?? (event.body ? (JSON.parse(event.body) as { memberId?: unknown }).memberId : undefined);
  if (typeof memberId !== 'string' || !memberId) return json(400, { error: 'missing_member_id' });

  if (!access.isAdmin) {
    const target = await resolveMemberProfile(memberId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  const tasks = await resolveMemberWeeklyTaskHistory(FORCA_TABLE_NAME, memberId);
  return json(200, { tasks });
}
