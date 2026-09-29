import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminDeleteWeeklyTask
// Body: { id: string }
// Auth: Cognito JWT, admin-only.
// Deletes the task and every trainee's completion record under it — unlike
// a Recurring Session's "future instances only" convention, a task has no
// separate "already happened" state to preserve, so this is a full cleanup,
// not a partial one.
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

  const pk = `WEEKLYTASK#${id}`;
  const completionsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': pk },
  }));
  const rows = (completionsRes.Items ?? []) as { PK: string; SK: string }[];

  await Promise.all(rows.map((r) =>
    ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: r.PK, SK: r.SK } })),
  ));
  // The Query above already includes the METADATA row itself (same PK), so
  // it's covered by the loop — nothing further to delete.

  return json(200, { success: true });
}
