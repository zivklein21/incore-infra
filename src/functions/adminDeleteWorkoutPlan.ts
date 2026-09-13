import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminDeleteWorkoutPlan
// Body: { id: string }
// Auth: Cognito JWT, caller must be admin
// Cascades: a plan and every one of its exercises share PK=WORKOUTPLAN#<id>
// (see entities.ts), so one Query finds them all to delete together — the
// frontend only ever deletes a whole plan, never leaves orphaned exercises.
// Hard delete — any ClassItem still carrying this plan's workoutPlanId is
// left untouched (denormalized workoutPlanName keeps that session's own
// history meaningful), same convention as adminDeleteTestGroup.ts leaving
// past TestAttemptItems alone.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${id}` },
  }));

  const items = (res.Items ?? []) as { PK: string; SK: string }[];
  await Promise.all(items.map((item) =>
    ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: item.PK, SK: item.SK } }))
  ));

  return json(200, { success: true });
}
