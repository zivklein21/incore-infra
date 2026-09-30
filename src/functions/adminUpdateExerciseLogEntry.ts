import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import { measurementValueSatisfies, type ExerciseLogEntryItem } from '../lib/entities';

// POST /adminUpdateExerciseLogEntry
// Body: { id: string, value: { weight?, reps?, timeSeconds?, bandLevel? }, loggedAt?: string }
// Auth: Cognito JWT, admin or a coach with performance:'read' — same gate as
// the read side (getMemberExerciseHistory.ts); the performance permission
// tier has no separate 'write' level, and correcting a trainee's Tracker
// history is meant to be available to any coach who can already see it, not
// admin-only. FORCA-only, same as every other Tracker endpoint.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  let body: { id?: unknown; value?: unknown; loggedAt?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });

  const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISELOG#${id}`, SK: 'METADATA' } }));
  const existing = existingRes.Item as ExerciseLogEntryItem | undefined;
  if (!existing) return json(404, { error: 'not_found' });

  // Same per-coach scoping as getMemberExerciseHistory.ts's own read path —
  // a coach can only touch entries belonging to a trainee in one of her
  // assigned groups, not any trainee in the system.
  if (!access.isAdmin) {
    const target = await resolveMemberProfile(existing.userId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  const raw = body.value && typeof body.value === 'object' ? body.value as Record<string, unknown> : {};
  const value: ExerciseLogEntryItem['value'] = {
    ...(typeof raw.weight === 'number' ? { weight: raw.weight } : {}),
    ...(typeof raw.reps === 'number' ? { reps: raw.reps } : {}),
    ...(typeof raw.timeSeconds === 'number' ? { timeSeconds: raw.timeSeconds } : {}),
    ...(typeof raw.bandLevel === 'string' && raw.bandLevel ? { bandLevel: raw.bandLevel } : {}),
  };
  if (!measurementValueSatisfies(existing.measurementType, value)) return json(400, { error: 'missing_value' });

  const loggedAt = typeof body.loggedAt === 'string' && body.loggedAt ? body.loggedAt : existing.loggedAt;

  // loggedAt is embedded in GSI1SK (getMemberExerciseHistory.ts sorts/scopes
  // on it), so a date change has to rewrite the sort key too — a partial
  // UpdateCommand on just `value`/`loggedAt` would leave GSI1SK stale and
  // the entry would keep sorting/filtering by its old date.
  const item: ExerciseLogEntryItem = {
    ...existing,
    GSI1SK: `EXERCISELOG#${existing.exerciseId}#${loggedAt}#${id}`,
    value,
    loggedAt,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, value, loggedAt });
}
