import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { TestDefinitionItem, TestResultItem } from '../lib/entities';

// GET or POST /getChildTestResults?childUid=xxx&testDefId=yyy
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of adminGetTestResults.ts
// — one daughter's full result history for one test, in instance order,
// each entry annotated with changeVsPrevious (same computation, just
// family-link authorized instead of coach/admin). Read-only: recording a
// result stays a coach/admin action (adminRecordTestResult.ts), never
// something a parent does herself.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const testDefId = event.queryStringParameters?.testDefId ?? '';
  if (!testDefId) return json(400, { error: 'missing_test_def_id' });

  const testDefRes = await ddb.send(new GetCommand({ TableName: link.table, Key: { PK: `TESTDEF#${testDefId}`, SK: 'METADATA' } }));
  const testDef = testDefRes.Item as TestDefinitionItem | undefined;
  if (!testDef) return json(404, { error: 'test_definition_not_found' });

  const res = await ddb.send(new QueryCommand({
    TableName: link.table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':skPrefix': `TESTRESULT#${testDefId}#` },
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
