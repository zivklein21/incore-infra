import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { WorkoutPackageTypeItem } from '../lib/entities';

// POST /adminSaveWorkoutPackageType
// Body: { id?: string, name: string } — omit id to create, pass id to rename.
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write' — same tier
// as building the plans that use this catalog (see
// adminSaveWorkoutPlan.ts). FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPACKAGE#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as WorkoutPackageTypeItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: WorkoutPackageTypeItem = {
    PK: `WORKOUTPACKAGE#${id}`,
    SK: 'METADATA',
    name,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, name });
}
