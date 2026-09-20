import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import type { ClassItem, WorkoutPlanItem } from '../lib/entities';

// POST /assignSessionWorkoutPlan
// Body: { classId: string, workoutPlanId: string | null } — null unassigns.
// Auth: Cognito JWT, caller must have workoutPlans:'write' (see
// coachAccess.ts) and the session's group must be one of hers — same
// session-ownership check toggleSessionEquipment.ts uses. Item 2's Monthly
// Calendar / ForcaSessionDetailPanel.tsx is the primary caller, but any
// session view (Home, coach's own sessions list) can use it too.
// A coach may only assign an active plan (matches what adminListWorkoutPlans.ts
// even shows her); an admin may assign a draft one too (e.g. to preview it
// on a real session before publishing).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; workoutPlanId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });
  if (body.workoutPlanId !== null && typeof body.workoutPlanId !== 'string') return json(400, { error: 'invalid_workout_plan_id' });
  const workoutPlanId = body.workoutPlanId === null ? null : body.workoutPlanId.trim() || null;

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: classKey }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });

  let workoutPlanName: string | null = null;
  if (workoutPlanId) {
    const planRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${workoutPlanId}`, SK: 'METADATA' } }));
    const plan = planRes.Item as WorkoutPlanItem | undefined;
    if (!plan) return json(404, { error: 'workout_plan_not_found' });
    if (!plan.active && !access.isAdmin) return json(403, { error: 'workout_plan_inactive' });
    workoutPlanName = plan.name;
  }

  // A session can be a Workout Plan OR a Test Session, never both — assigning
  // a plan here clears any Test Session already on it, mirroring
  // assignSessionTestGroup.ts's own clear-the-other-side behavior.
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: classKey,
    UpdateExpression: workoutPlanId
      ? 'SET workoutPlanId = :id, workoutPlanName = :name REMOVE isTestSession, testGroupId, testGroupName, testComponentIds'
      : 'REMOVE workoutPlanId, workoutPlanName',
    ...(workoutPlanId ? { ExpressionAttributeValues: { ':id': workoutPlanId, ':name': workoutPlanName } } : {}),
  }));

  return json(200, { success: true, workoutPlanId, workoutPlanName });
}
