import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { exerciseKey } from '../incoreExercises';

// POST /adminDeleteIncoreExercise
// Body: { id: string }
// Auth: Cognito JWT, admin only. Hard delete of the catalog row — trainees'
// already-logged workouts are unaffected since every IncoreWorkoutLogItem
// snapshots the exercise's name/muscle group/metrics at save time. (To just
// hide an exercise from the picker while keeping it editable, save it with
// active: false instead.)
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return json(400, { error: 'missing_id' });

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: exerciseKey(id) }));

  return json(200, { success: true });
}
