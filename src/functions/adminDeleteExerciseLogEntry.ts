import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import type { ExerciseLogEntryItem } from '../lib/entities';

// POST /adminDeleteExerciseLogEntry
// Body: { id: string }
// Auth: Cognito JWT, admin or a coach with performance:'read' — see
// adminUpdateExerciseLogEntry.ts for why this reuses the read tier rather
// than a dedicated write permission. A coach is further scoped to only
// entries belonging to a trainee in one of her assigned groups, same as
// that endpoint. FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  let body: { id?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });

  if (!access.isAdmin) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISELOG#${id}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as ExerciseLogEntryItem | undefined;
    if (!existing) return json(404, { error: 'not_found' });
    const target = await resolveMemberProfile(existing.userId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISELOG#${id}`, SK: 'METADATA' } }));
  return json(200, { success: true });
}
