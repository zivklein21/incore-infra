import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deleteSessionInstance } from '../lib/sessionInstance';
import type { ClassItem } from '../lib/entities';

// POST /adminCancelSessionInstance
// Body: { classId: string }
// Auth: Cognito JWT, admin-only — same gating as adminUpdateSessionInstance.ts.
//
// Cancels exactly ONE dated session instance — its own ClassItem and every
// registration under it (CLASS#<id>/REG#<uid>) — without touching its
// recurring template or any other instance the template generated (compare
// adminDeleteRecurringSession.ts, which removes the whole future set at
// once). Reachable from the Monthly Calendar's per-session detail view.
// Only a not-yet-occurred session can be cancelled — a past one is the
// historical record getTrainingHistory.ts reads, same "future only" rule
// deleteFutureInstances() already enforces for the bulk case; an already
// closed session (closedAt set) is rejected too, since a closed session by
// definition already happened and has recorded attendance/equipment worth
// keeping.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (session.closedAt) return json(400, { error: 'session_already_closed' });
  if (session.date < new Date().toISOString()) return json(400, { error: 'session_already_occurred' });

  await deleteSessionInstance(classId);

  return json(200, { success: true });
}
