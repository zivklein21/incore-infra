import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { WorkoutPlanBlockItem } from '../lib/entities';

// POST /adminDeleteWorkoutPlanBlock
// Body: { id: string, planId: string } — planId is required because
// PK=WORKOUTPLAN#<planId>/SK=BLOCK#<id> is a composite key.
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write'.
// Refuses to delete the mandatory closing section (locked: true, set once
// by adminSaveWorkoutPlan.ts on plan creation) — the one hard guarantee
// behind "every plan always has a Summary & Debrief section," independent
// of what the builder UI does or doesn't offer.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

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

  const key = { PK: `WORKOUTPLAN#${planId}`, SK: `BLOCK#${id}` };
  const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const existing = existingRes.Item as WorkoutPlanBlockItem | undefined;
  if (existing?.locked) return json(403, { error: 'section_locked' });

  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: key }));

  return json(200, { success: true });
}
