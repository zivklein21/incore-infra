import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { WorkoutPlanItem, WorkoutPlanExerciseItem } from '../lib/entities';

// GET or POST /adminListWorkoutPlans
// Auth: Cognito JWT, admin or a coach with workoutPlans:'read' or 'write' —
// same admin-sees-drafts-too / coach-sees-active-only split as
// adminListTestGroups.ts. Used both by the admin builder
// (WorkoutPlansManageScreen.tsx) and by a coach's "assign a plan to this
// session" picker (assignSessionWorkoutPlan.ts is the write side).
//
// One Scan over the WORKOUTPLAN# prefix returns both METADATA and EXERCISE#
// items (same partition per plan — see entities.ts), assembled here into
// { workoutPlans: [{ ...plan, exercises: [...] }] }, exercises sorted by
// their `order` attribute (not scan/insertion order, which DynamoDB never
// guarantees).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = event.requestContext.authorizer.jwt.claims.sub as string;
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans === 'none') return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'WORKOUTPLAN#' },
  }));

  const items = (res.Items ?? []) as ((WorkoutPlanItem | WorkoutPlanExerciseItem) & { PK: string; SK: string })[];

  const plansById = new Map<string, ReturnType<typeof toPlanShape>>();
  for (const item of items) {
    if (item.SK !== 'METADATA') continue;
    const plan = item as WorkoutPlanItem & { PK: string };
    plansById.set(plan.PK.replace('WORKOUTPLAN#', ''), toPlanShape(plan));
  }
  for (const item of items) {
    if (item.SK === 'METADATA') continue;
    const exercise = item as WorkoutPlanExerciseItem & { PK: string; SK: string };
    const planId = exercise.PK.replace('WORKOUTPLAN#', '');
    const plan = plansById.get(planId);
    if (plan) plan.exercises.push(toExerciseShape(exercise));
  }

  const workoutPlans = [...plansById.values()]
    .filter((p) => access.isAdmin || p.active)
    .map((p) => ({ ...p, exercises: p.exercises.sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { workoutPlans });
}

function toPlanShape(p: WorkoutPlanItem & { PK: string }) {
  return {
    id: p.PK.replace('WORKOUTPLAN#', ''),
    name: p.name,
    description: p.description ?? '',
    active: p.active,
    exercises: [] as ReturnType<typeof toExerciseShape>[],
  };
}

function toExerciseShape(e: WorkoutPlanExerciseItem & { PK: string; SK: string }) {
  return {
    id: e.SK.replace('EXERCISE#', ''),
    planId: e.planId,
    exerciseId: e.exerciseId,
    exerciseName: e.exerciseName,
    order: e.order,
    sets: e.sets ?? null,
    reps: e.reps ?? null,
    restSeconds: e.restSeconds ?? null,
    notes: e.notes ?? null,
  };
}
