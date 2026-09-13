import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminDeleteWorkoutPlanExercise
// Body: { id: string, planId: string } — planId is required because
// PK=WORKOUTPLAN#<planId>/SK=EXERCISE#<id> is a composite key (see
// entities.ts); deleting the plan itself is adminDeleteWorkoutPlan.ts.
// Auth: Cognito JWT, caller must be admin
// Hard delete — remaining exercises' `order` values are left as-is (gaps
// are fine, the list is always re-sorted by order at read time, never by
// position), same non-renumbering convention adminDeleteTestComponent.ts
// follows for its own list.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; planId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });
  const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
  if (!planId) return json(400, { error: 'missing_plan_id' });

  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${planId}`, SK: `EXERCISE#${id}` } }));

  return json(200, { success: true });
}
