import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import type { TestDefinitionItem, TestResultItem } from '../lib/entities';

// GET or POST /adminGetTestResults
// Query/body: { memberId: string, testDefId: string }
// Auth: Cognito JWT, admin or a coach with performance:'read' (view-only —
// see adminRecordTestResult.ts for the coach's one write action here). A
// coach only sees trainees in one of her assigned groups.
// One member's full result history for one test, in instance order — each
// entry annotated with changeVsPrevious so the frontend never needs the
// higherIsBetter comparison logic itself.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  let memberId = event.queryStringParameters?.memberId ?? '';
  let testDefId = event.queryStringParameters?.testDefId ?? '';
  if ((!memberId || !testDefId) && event.body) {
    try {
      const body = JSON.parse(event.body) as { memberId?: unknown; testDefId?: unknown };
      if (!memberId && typeof body.memberId === 'string') memberId = body.memberId;
      if (!testDefId && typeof body.testDefId === 'string') testDefId = body.testDefId;
    } catch { /* ignore */ }
  }
  if (!memberId) return json(400, { error: 'missing_member_id' });
  if (!testDefId) return json(400, { error: 'missing_test_def_id' });

  if (!access.isAdmin) {
    const target = await resolveMemberProfile(memberId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  const testDefRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTDEF#${testDefId}`, SK: 'METADATA' } }));
  const testDef = testDefRes.Item as TestDefinitionItem | undefined;
  if (!testDef) return json(404, { error: 'test_definition_not_found' });

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':skPrefix': `TESTRESULT#${testDefId}#` },
  }));

  const sorted = ((res.Items ?? []) as (TestResultItem & { PK: string })[])
    .sort((a, b) => a.instanceNumber - b.instanceNumber);

  const results = sorted.map((r, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    const changeVsPrevious: 'up' | 'down' | 'same' | null = !prev ? null
      : r.score === prev.score ? 'same'
      : (testDef.higherIsBetter ? r.score > prev.score : r.score < prev.score) ? 'up' : 'down';

    return {
      id: r.PK.replace('TESTRESULT#', ''),
      instanceNumber: r.instanceNumber,
      score: r.score,
      date: r.date,
      changeVsPrevious,
    };
  });

  return json(200, {
    testDefinition: { id: testDefId, name: testDef.name, unit: testDef.unit ?? null, higherIsBetter: testDef.higherIsBetter },
    results,
  });
}
