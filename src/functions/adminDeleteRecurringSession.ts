import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deleteFutureInstances } from '../lib/sessionInstance';

// POST /adminDeleteRecurringSession
// Body: { id: string }
// Auth: Cognito JWT, caller must be admin
// Deletes the template and every not-yet-occurred instance it generated —
// past instances stay untouched (they're the historical record
// getTrainingHistory.ts reads).
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

  const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `RECURRINGSESSION#${id}`, SK: 'METADATA' } }));
  if (!existingRes.Item) return json(404, { error: 'recurring_session_not_found' });

  const removedCount = await deleteFutureInstances(id);
  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `RECURRINGSESSION#${id}`, SK: 'METADATA' } }));

  return json(200, { success: true, removedCount });
}
