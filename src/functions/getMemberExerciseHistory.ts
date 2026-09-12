import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import type { ExerciseLogEntryItem } from '../lib/entities';

// GET or POST /getMemberExerciseHistory
// Query/body: { memberId: string, exerciseId?: string }
// Auth: Cognito JWT, admin or a coach with performance:'read' — the Tracker
// dashboard's chart data source (view-only for a coach; kept the "admin"
// name to avoid a route/frontend rename, same as adminListTestDefinitions.ts/
// adminGetTestResults.ts/adminRecordTestResult.ts). A coach only sees
// trainees in one of her assigned groups. Same query as
// getMyExerciseHistory.ts, for an arbitrary member instead of the caller herself.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  let memberId = event.queryStringParameters?.memberId ?? '';
  let exerciseId = event.queryStringParameters?.exerciseId ?? '';
  if ((!memberId || !exerciseId) && event.body) {
    try {
      const body = JSON.parse(event.body) as { memberId?: unknown; exerciseId?: unknown };
      if (!memberId && typeof body.memberId === 'string') memberId = body.memberId;
      if (!exerciseId && typeof body.exerciseId === 'string') exerciseId = body.exerciseId;
    } catch { /* ignore */ }
  }
  if (!memberId) return json(400, { error: 'missing_member_id' });

  if (!access.isAdmin) {
    const target = await resolveMemberProfile(memberId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `MEMBER#${memberId}`,
      ':skPrefix': exerciseId ? `EXERCISELOG#${exerciseId}#` : 'EXERCISELOG#',
    },
  }));

  const entries = ((res.Items ?? []) as (ExerciseLogEntryItem & { PK: string })[])
    .map((e) => ({
      id: e.PK.replace('EXERCISELOG#', ''),
      exerciseId: e.exerciseId,
      exerciseName: e.exerciseName,
      measurementType: e.measurementType,
      value: e.value,
      loggedAt: e.loggedAt,
    }))
    .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));

  return json(200, { entries });
}
