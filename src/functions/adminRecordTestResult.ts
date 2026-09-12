import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import type { TestDefinitionItem, TestResultItem } from '../lib/entities';

// Zero-padded so GSI1SK's lexicographic ordering matches numeric order
// (instance 2 must sort before instance 10, not after).
const INSTANCE_PAD = 6;

// POST /adminRecordTestResult
// Body: { memberId: string, testDefId: string, score: number, date?: string }
// Auth: Cognito JWT, admin or a coach with performance:'read' — this is an
// evaluation record, not a trainee self-log (see entities.ts's
// TestResultItem comment). A coach may record a result for any trainee in
// one of her assigned groups; the rest of the Tracker module stays
// view-only for her (see getMemberExerciseHistory.ts/adminGetTestResults.ts)
// — this is deliberately the second write action a coach account has
// anywhere in the FORCA Coach feature, alongside markActualAttendance.ts.
// instanceNumber is computed here, not client-supplied — counts this
// member's existing results for this test and adds one.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; testDefId?: unknown; score?: unknown; date?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const testDefId = typeof body.testDefId === 'string' ? body.testDefId.trim() : '';
  if (!testDefId) return json(400, { error: 'missing_test_def_id' });
  const score = typeof body.score === 'number' && Number.isFinite(body.score) ? body.score : null;
  if (score === null) return json(400, { error: 'invalid_score' });
  const date = typeof body.date === 'string' && body.date ? body.date : new Date().toISOString();

  if (!access.isAdmin) {
    const target = await resolveMemberProfile(memberId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  const testDefRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTDEF#${testDefId}`, SK: 'METADATA' } }));
  const testDef = testDefRes.Item as TestDefinitionItem | undefined;
  if (!testDef) return json(404, { error: 'test_definition_not_found' });

  const existingRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':skPrefix': `TESTRESULT#${testDefId}#` },
    Select: 'COUNT',
  }));
  const instanceNumber = (existingRes.Count ?? 0) + 1;

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  const paddedInstance = String(instanceNumber).padStart(INSTANCE_PAD, '0');

  const item: TestResultItem = {
    PK: `TESTRESULT#${id}`,
    SK: 'METADATA',
    GSI1PK: `MEMBER#${memberId}`,
    GSI1SK: `TESTRESULT#${testDefId}#${paddedInstance}#${id}`,
    userId: memberId,
    testDefId,
    testDefName: testDef.name,
    instanceNumber,
    score,
    date,
    createdAt: nowIso,
    createdBy: callerUid,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, instanceNumber });
}
