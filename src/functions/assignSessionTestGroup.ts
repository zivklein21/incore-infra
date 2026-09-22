import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import type { ClassItem, TestGroupItem } from '../lib/entities';

// POST /assignSessionTestGroup
// Body: { classId: string, testGroupId: string | null, testComponentIds?: string[] | null }
// testGroupId: null unassigns (clears isTestSession/testGroupId/testGroupName/
// testComponentIds together). testComponentIds, when provided, narrows
// grading to a subset of the group's components ("sub-tests") — pass null or
// omit for "every active component of the group applies".
//
// Auth: Cognito JWT, caller must have testsGrading:'write' (admins/coaches —
// same axis that gates actually recording a grade, see
// adminRecordTestAttempt.ts) and the session's group must be one of hers —
// same session-ownership check assignSessionWorkoutPlan.ts uses.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.testsGrading !== 'write') return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; testGroupId?: unknown; testComponentIds?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });
  if (body.testGroupId !== null && typeof body.testGroupId !== 'string') return json(400, { error: 'invalid_test_group_id' });
  const testGroupId = body.testGroupId === null ? null : body.testGroupId.trim() || null;

  let testComponentIds: string[] | null = null;
  if (Array.isArray(body.testComponentIds)) {
    if (!body.testComponentIds.every((id): id is string => typeof id === 'string')) {
      return json(400, { error: 'invalid_test_component_ids' });
    }
    testComponentIds = body.testComponentIds;
  } else if (body.testComponentIds !== undefined && body.testComponentIds !== null) {
    return json(400, { error: 'invalid_test_component_ids' });
  }

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: classKey }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });

  let testGroupName: string | null = null;
  if (testGroupId) {
    const groupRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTGROUP#${testGroupId}`, SK: 'METADATA' } }));
    const group = groupRes.Item as TestGroupItem | undefined;
    if (!group) return json(404, { error: 'test_group_not_found' });
    testGroupName = group.name;
  }

  if (testGroupId) {
    const sets = ['isTestSession = :isTestSession', 'testGroupId = :testGroupId', 'testGroupName = :testGroupName'];
    const values: Record<string, unknown> = {
      ':isTestSession': true,
      ':testGroupId': testGroupId,
      ':testGroupName': testGroupName,
    };
    // A session can be a Test Session OR a Workout Plan, never both —
    // assigning a test here clears any Workout Plan already on it, mirroring
    // assignSessionWorkoutPlan.ts's own clear-the-other-side behavior.
    const removes: string[] = ['workoutPlanId', 'workoutPlanName'];
    if (testComponentIds && testComponentIds.length > 0) {
      sets.push('testComponentIds = :testComponentIds');
      values[':testComponentIds'] = testComponentIds;
    } else {
      removes.push('testComponentIds');
    }
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: classKey,
      UpdateExpression: `SET ${sets.join(', ')}${removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeValues: values,
    }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: classKey,
      UpdateExpression: 'REMOVE isTestSession, testGroupId, testGroupName, testComponentIds',
    }));
  }

  return json(200, { success: true, isTestSession: !!testGroupId, testGroupId, testGroupName, testComponentIds });
}
