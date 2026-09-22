import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import { rankAttemptsByDate, changeVsPrevious } from '../lib/testAttemptOrdering';
import type { TestGroupItem, TestAttemptItem } from '../lib/entities';

// GET or POST /getMyTestAttempts?groupId=yyy
// Auth: Cognito JWT (any signed-in member — self-service, same as
// getMyExerciseHistory.ts)
//
// A trainee viewing her OWN test results directly, not via a parent's Child
// Switcher — structural clone of getChildTestAttempts.ts (same shape,
// same rankAttemptsByDate/changeVsPrevious computation) but resolved
// against the caller's own uid instead of a family-link-verified childUid.
// Fills the gap where a trainee previously had no self-service view of her
// test/quiz results at all (only a parent could see them, via
// getChildTestAttempts.ts). Read-only: recording an attempt stays a
// coach/admin action (adminRecordTestAttempt.ts).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const groupId = event.queryStringParameters?.groupId ?? '';
  if (!groupId) return json(400, { error: 'missing_group_id' });

  const resolved = await resolveMemberProfile(callerUid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table } = resolved;

  const groupRes = await ddb.send(new GetCommand({ TableName: table, Key: { PK: `TESTGROUP#${groupId}`, SK: 'METADATA' } }));
  const group = groupRes.Item as TestGroupItem | undefined;
  if (!group) return json(404, { error: 'test_group_not_found' });

  const res = await ddb.send(new QueryCommand({
    TableName: table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':skPrefix': `TESTATTEMPT#${groupId}#` },
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
        finalScore: r.finalScore,
        finalPassed: r.finalPassed,
        changeVsPrevious: changeVsPrevious(r, prevResult),
      };
    });

    return {
      id: attempt.PK.replace('TESTATTEMPT#', ''),
      instanceNumber: rank,
      date: attempt.date,
      componentResults,
      overallScore: attempt.overallScore,
      overallPassed: attempt.overallPassed,
    };
  });

  return json(200, {
    testGroup: { id: groupId, name: group.name },
    attempts,
  });
}
