import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import type { ClassItem, TrainingTypeItem, WorkoutPlanItem } from '../lib/entities';

// POST /assignSessionWorkoutPlan
// Body: { classId: string, workoutPlanId: string | null } — null unassigns.
// Auth: Cognito JWT, caller must have workoutPlans:'write' (see
// coachAccess.ts) and the session's group must be one of hers — same
// session-ownership check toggleSessionEquipment.ts uses. Item 2's Monthly
// Calendar / ForcaSessionDetailPanel.tsx is the primary caller, but any
// session view (Home, coach's own sessions list) can use it too.
// A coach may only assign an active plan (matches what adminListWorkoutPlans.ts
// even shows her); an admin may assign a draft one too (e.g. to preview it
// on a real session before publishing). Also re-resolves isRunningSession
// (TrainingType.category === 'running' OR the (un)assigned plan's own
// category) on every call — see entities.ts's WorkoutPlanItem.category.
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
  let planIsRunning = false;
  if (workoutPlanId) {
    const planRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${workoutPlanId}`, SK: 'METADATA' } }));
    const plan = planRes.Item as WorkoutPlanItem | undefined;
    if (!plan) return json(404, { error: 'workout_plan_not_found' });
    if (!plan.active && !access.isAdmin) return json(403, { error: 'workout_plan_inactive' });
    workoutPlanName = plan.name;
    planIsRunning = plan.category === 'running';
  }

  // isRunningSession is the OR of two independent sources — the session's
  // own TrainingType category (unaffected by this call) and the plan being
  // assigned/unassigned here — see entities.ts's WorkoutPlanItem.category
  // comment. Re-resolved on every call rather than trusting the session's
  // existing flag, since assigning/unassigning a plan is exactly the
  // moment the plan side of that OR can change.
  let trainingTypeIsRunning = false;
  if (session.trainingTypeId) {
    const trainingTypeRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${session.trainingTypeId}`, SK: 'METADATA' } }));
    trainingTypeIsRunning = (trainingTypeRes.Item as TrainingTypeItem | undefined)?.category === 'running';
  }
  const isRunningSession = trainingTypeIsRunning || planIsRunning;

  // A session can be a Workout Plan OR a Test Session, never both — assigning
  // a plan here clears any Test Session already on it, mirroring
  // assignSessionTestGroup.ts's own clear-the-other-side behavior.
  const setClauses = workoutPlanId ? ['workoutPlanId = :id', 'workoutPlanName = :name'] : [];
  const removeClauses = workoutPlanId ? ['isTestSession', 'testGroupId', 'testGroupName', 'testComponentIds'] : ['workoutPlanId', 'workoutPlanName'];
  const values: Record<string, unknown> = workoutPlanId ? { ':id': workoutPlanId, ':name': workoutPlanName } : {};
  if (isRunningSession) { setClauses.push('isRunningSession = :isRunning'); values[':isRunning'] = true; }
  else { removeClauses.push('isRunningSession'); }

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: classKey,
    UpdateExpression: `${setClauses.length ? `SET ${setClauses.join(', ')}` : ''} REMOVE ${removeClauses.join(', ')}`.trim(),
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  }));

  return json(200, { success: true, workoutPlanId, workoutPlanName });
}
