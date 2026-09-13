import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { WorkoutPlanItem } from '../lib/entities';

// POST /adminSaveWorkoutPlan
// Body: { id?: string, name: string, description?: string, active?: boolean }
//   — omit id to create
// Auth: Cognito JWT, caller must be admin — building/editing plans is
// admin-only (same as the Tests & Quizzes catalog); a coach's only write
// action against a plan is assigning an already-published one to her own
// session (see assignSessionWorkoutPlan.ts).
// Plan metadata only — exercises are saved separately via
// adminSaveWorkoutPlanExercise.ts, same split as adminSaveTestGroup.ts /
// adminSaveTestComponent.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; description?: unknown; active?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const description = typeof body.description === 'string' ? body.description.trim() : undefined;

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as WorkoutPlanItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: WorkoutPlanItem = {
    PK: `WORKOUTPLAN#${id}`,
    SK: 'METADATA',
    name,
    ...(description ? { description } : {}),
    active: body.active === true,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
