import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import type { IncoreWorkoutLogItem } from '../entities';
import { refreshLastWeights } from './lastWeights';

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

  const res = await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${callerUid}`, SK: `WORKOUTLOG#${id}` },
    ReturnValues: 'ALL_OLD',
  }));

  // The deleted log may have been some exercise's "last working weight".
  const removed = res.Attributes as IncoreWorkoutLogItem | undefined;
  const touched = (removed?.exercises ?? []).map((e) => e.exerciseId);
  if (touched.length > 0) {
    await refreshLastWeights(callerUid, touched).catch((err) => console.error('[deleteMyWorkoutLog] lastWeights refresh failed', err));
  }

  return json(200, { success: true });
}
