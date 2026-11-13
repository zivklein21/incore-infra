import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { rankAttemptsByDate, changeVsPrevious } from '../lib/testAttemptOrdering';
import { decodeRowCursor, windowRows } from '../lib/datePaging';
import type { TestGroupItem, TestAttemptItem } from '../lib/entities';

// GET or POST /getChildTestAttempts?childUid=xxx&groupId=yyy
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of adminGetTestAttempts.ts
// — one daughter's full attempt history for one test group, in instance
// order, each component result annotated with changeVsPrevious (same
// computation, just family-link authorized instead of coach/admin).
// Read-only: recording an attempt stays a coach/admin action
// (adminRecordTestAttempt.ts), never something a parent does herself.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const groupId = event.queryStringParameters?.groupId ?? '';
  if (!groupId) return json(400, { error: 'missing_group_id' });

  const groupRes = await ddb.send(new GetCommand({ TableName: link.table, Key: { PK: `TESTGROUP#${groupId}`, SK: 'METADATA' } }));
  const group = groupRes.Item as TestGroupItem | undefined;
  if (!group) return json(404, { error: 'test_group_not_found' });

  const res = await ddb.send(new QueryCommand({
    TableName: link.table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':skPrefix': `TESTATTEMPT#${groupId}#` },
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

  // ?paged=1 (app 1.5.2+): newest first, the last 2 months, then 2 more per
  // Load more. Ranking and change-vs-previous are computed on the full set
  // above, so they stay correct on every page.
  const qs = event.queryStringParameters ?? {};
  if (qs.paged === '1' || qs.paged === 'true') {
    const cursor = qs.cursor ? decodeRowCursor(qs.cursor) : null;
    if (qs.cursor && !cursor) return json(400, { error: 'invalid_cursor' });
    const page = windowRows(attempts.map((a) => ({ a, id: a.id, date: a.date })), cursor);
    return json(200, {
      testGroup: { id: groupId, name: group.name },
      attempts: page.items.map((x) => x.a),
      nextCursor: page.nextCursor,
      coveredFrom: page.coveredFrom,
    });
  }

  return json(200, {
    testGroup: { id: groupId, name: group.name },
    attempts,
  });
}
