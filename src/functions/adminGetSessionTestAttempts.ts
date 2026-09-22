import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import type { ClassItem, RegistrationItem, TestAttemptItem } from '../lib/entities';

// GET or POST /adminGetSessionTestAttempts?classId=xxx
// Auth: Cognito JWT, admin or a coach with testsGrading:'read'/'write', and
// the session's group must be one of hers — same session-ownership check
// assignSessionWorkoutPlan.ts uses.
//
// The coach-only post-test-session grading panel (see
// ForcaSessionDetailPanel.tsx's TestSessionGradingPanel) needs, in one call,
// "for every roster member, has she already been graded for THIS session's
// linked test group, and what was the result" — adminGetTestAttempts.ts
// only covers one member at a time, so this fans out one GSI1 query per
// roster member (each scoped to the session's testGroupId) and keeps only
// the most recent attempt whose classId matches this exact session,
// distinguishing "graded from this test session" from "has an unrelated
// attempt at some other time" for the same trainee/group.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.testsGrading === 'none') return json(403, { error: 'forbidden' });

  const classId = event.queryStringParameters?.classId ?? '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });
  if (!session.testGroupId) return json(400, { error: 'not_a_test_session' });

  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
  }));
  const memberIds = ((regsRes.Items ?? []) as RegistrationItem[]).map((r) => r.userId);

  const results = await Promise.all(memberIds.map(async (memberId) => {
    const attemptsRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':skPrefix': `TESTATTEMPT#${session.testGroupId}#` },
    }));
    const attempts = (attemptsRes.Items ?? []) as TestAttemptItem[];
    const forThisSession = attempts.find((a) => a.classId === classId) ?? null;
    return {
      memberId,
      graded: !!forThisSession,
      overallScore: forThisSession?.overallScore ?? null,
      overallPassed: forThisSession?.overallPassed ?? null,
    };
  }));

  return json(200, {
    testGroupId: session.testGroupId,
    testGroupName: session.testGroupName ?? null,
    testComponentIds: session.testComponentIds ?? null,
    results,
  });
}
