import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';

// POST /deleteMyWorkoutLog
// Body: { id: string }
// Auth: Cognito JWT, any signed-in INCORE member. The key is built from the
// caller's own uid, so this can only ever delete from the caller's journal.
// Deleting a class-linked log (`cls_<classId>`) puts that class back into
// getMyWorkoutJournal.ts's unloggedSessions (if still inside its window).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { id?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return json(400, { error: 'missing_id' });

  await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${callerUid}`, SK: `WORKOUTLOG#${id}` },
  }));

  return json(200, { success: true });
}
