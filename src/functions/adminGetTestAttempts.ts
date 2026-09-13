import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import { rankAttemptsByDate, changeVsPrevious } from '../lib/testAttemptOrdering';
import type { TestAttemptItem } from '../lib/entities';

// GET or POST /adminGetTestAttempts
// Query/body: { memberId: string, groupId: string }
// Auth: Cognito JWT, admin or a coach with performance:'read' (view-only —
// see adminRecordTestAttempt.ts for the coach's one write action here). A
// coach only sees trainees in one of her assigned groups.
// One member's full attempt history for one test group, ranked by date (see
// testAttemptOrdering.ts) — each component result annotated with
// changeVsPrevious (comparing chronologically-consecutive attempts' rawValue
// for that componentId) so the frontend never needs the higherIsBetter
// comparison logic itself.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  let memberId = event.queryStringParameters?.memberId ?? '';
  let groupId = event.queryStringParameters?.groupId ?? '';
  if ((!memberId || !groupId) && event.body) {
    try {
      const body = JSON.parse(event.body) as { memberId?: unknown; groupId?: unknown };
      if (!memberId && typeof body.memberId === 'string') memberId = body.memberId;
      if (!groupId && typeof body.groupId === 'string') groupId = body.groupId;
    } catch { /* ignore */ }
  }
  if (!memberId) return json(400, { error: 'missing_member_id' });
  if (!groupId) return json(400, { error: 'missing_group_id' });

  if (!access.isAdmin) {
    const target = await resolveMemberProfile(memberId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTGROUP#${groupId}`, SK: 'METADATA' } }));
  if (!groupRes.Item) return json(404, { error: 'test_group_not_found' });

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':skPrefix': `TESTATTEMPT#${groupId}#` },
  }));

  const items = (res.Items ?? []) as (TestAttemptItem & { PK: string })[];

  const attempts = rankAttemptsByDate(items).map(({ attempt, rank, prev }) => {
    const componentResults = attempt.componentResults.map((r) => {
      const prevResult = prev?.componentResults.find((pr) => pr.componentId === r.componentId) ?? null;
      return {
        componentId: r.componentId,
        componentName: r.componentName,
        metricType: r.metricType,
        bandLevels: r.bandLevels,
        rawValue: r.rawValue,
        computedScore: r.computedScore,
        computedPassed: r.computedPassed,
        overrideScore: r.overrideScore,
        overridePassed: r.overridePassed,
        finalScore: r.finalScore,
        finalPassed: r.finalPassed,
        changeVsPrevious: changeVsPrevious(r, prevResult),
      };
    });

    return {
      id: attempt.PK.replace('TESTATTEMPT#', ''),
      groupId: attempt.groupId,
      instanceNumber: rank,
      date: attempt.date,
      componentResults,
      overallScore: attempt.overallScore,
      overallPassed: attempt.overallPassed,
    };
  });

  return json(200, { attempts });
}
