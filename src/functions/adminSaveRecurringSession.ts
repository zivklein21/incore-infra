import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { GroupItem, RecurringSessionItem, TrainingTypeItem } from '../lib/entities';
import { createSessionInstance, deleteFutureInstances, upcomingOccurrences } from '../lib/sessionInstance';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// POST /adminSaveRecurringSession
// Body: { id?: string, groupId: string, trainingTypeId: string, dayOfWeek: number (0=Sun..6=Sat),
//         time: string ("HH:mm"), location?: string, coachId?: string, coachName?: string } — omit id to create
// Auth: Cognito JWT, caller must be admin
//
// Create: writes the RecurringSessionItem template, then materializes
// concrete ClassItem instances (via lib/sessionInstance.ts's
// createSessionInstance()) for every matching weekday from today through
// the end of the current month.
//
// Update: a change to the pattern itself (dayOfWeek/time/groupId) deletes
// every not-yet-occurred instance this template previously generated and
// regenerates fresh ones on the new pattern — reliably correct without
// needing to reschedule individual dates. A change to trainingTypeId/
// coachId/coachName/location only (pattern unchanged) instead patches those
// fields in place on every not-yet-occurred instance, same "apply to future
// occurrences" idea saveClassSeries.ts already uses for INCORE. Past
// instances are never touched either way.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; groupId?: unknown; trainingTypeId?: unknown; dayOfWeek?: unknown; time?: unknown;
    location?: unknown; coachId?: unknown; coachName?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  if (!groupId) return json(400, { error: 'missing_group_id' });
  const trainingTypeId = typeof body.trainingTypeId === 'string' ? body.trainingTypeId.trim() : '';
  if (!trainingTypeId) return json(400, { error: 'missing_training_type_id' });
  const dayOfWeek = typeof body.dayOfWeek === 'number' ? body.dayOfWeek : NaN;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return json(400, { error: 'invalid_day_of_week' });
  const time = typeof body.time === 'string' ? body.time : '';
  if (!TIME_RE.test(time)) return json(400, { error: 'invalid_time' });
  const location = typeof body.location === 'string' && body.location.trim() ? body.location.trim() : undefined;
  const coachId = typeof body.coachId === 'string' && body.coachId ? body.coachId : undefined;
  const coachName = typeof body.coachName === 'string' && body.coachName.trim() ? body.coachName.trim() : undefined;

  const [groupRes, trainingTypeRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${groupId}`, SK: 'METADATA' } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${trainingTypeId}`, SK: 'METADATA' } })),
  ]);
  const group = groupRes.Item as GroupItem | undefined;
  if (!group) return json(404, { error: 'group_not_found' });
  const trainingType = trainingTypeRes.Item as TrainingTypeItem | undefined;
  if (!trainingType) return json(404, { error: 'training_type_not_found' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  let existing: RecurringSessionItem | undefined;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `RECURRINGSESSION#${existingId}`, SK: 'METADATA' } }));
    existing = existingRes.Item as RecurringSessionItem | undefined;
    if (!existing) return json(404, { error: 'recurring_session_not_found' });
  }

  const id = existingId ?? randomUUID();
  const item: RecurringSessionItem = {
    PK: `RECURRINGSESSION#${id}`,
    SK: 'METADATA',
    groupId,
    trainingTypeId,
    dayOfWeek,
    time,
    active: true,
    ...(location ? { location } : {}),
    ...(coachId ? { coachId, coachName } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    createdBy: existing?.createdBy ?? callerUid,
  };
  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  let instancesCreated = 0;
  let registeredCount = 0;

  if (!existing) {
    for (const date of upcomingOccurrences(new Date(), dayOfWeek, time)) {
      const result = await createSessionInstance({
        groupId, trainingTypeId, date, createdBy: callerUid, location, coachId, coachName, recurringSessionId: id,
      });
      if (!result.ok) {
        // Deterministic per group/type — if the first occurrence fails
        // (no members, e.g.), every later one would too; no point retrying.
        if (instancesCreated === 0) {
          const status = result.error === 'group_has_no_members' ? 400 : 404;
          return json(status, { error: result.error });
        }
        break;
      }
      instancesCreated += 1;
      registeredCount += result.registeredCount;
    }
  } else {
    const patternChanged = existing.groupId !== groupId || existing.dayOfWeek !== dayOfWeek || existing.time !== time;

    if (patternChanged) {
      await deleteFutureInstances(id);
      for (const date of upcomingOccurrences(new Date(), dayOfWeek, time)) {
        const result = await createSessionInstance({
          groupId, trainingTypeId, date, createdBy: callerUid, location, coachId, coachName, recurringSessionId: id,
        });
        if (!result.ok) {
          if (instancesCreated === 0) {
            const status = result.error === 'group_has_no_members' ? 400 : 404;
            return json(status, { error: result.error });
          }
          break;
        }
        instancesCreated += 1;
        registeredCount += result.registeredCount;
      }
    } else {
      // Pattern unchanged — patch trainingType/coach/location in place on
      // every not-yet-occurred instance, same idea as saveClassSeries.ts.
      const nowIso = new Date().toISOString();
      const futureRes = await ddb.send(new ScanCommand({
        TableName: FORCA_TABLE_NAME,
        FilterExpression: 'recurringSessionId = :rsid AND #dt >= :now',
        ExpressionAttributeNames: { '#dt': 'date' },
        ExpressionAttributeValues: { ':rsid': id, ':now': nowIso },
      }));
      const futureItems = (futureRes.Items ?? []) as { PK: string }[];
      const setClauses = ['className = :className', 'trainingTypeId = :ttid'];
      const removeClauses: string[] = [];
      const values: Record<string, unknown> = { ':className': trainingType.name, ':ttid': trainingTypeId };
      if (location) { setClauses.push('#loc = :loc'); values[':loc'] = location; } else { removeClauses.push('#loc'); }
      if (coachId) { setClauses.push('coachId = :coachId', 'coachName = :coachName'); values[':coachId'] = coachId; values[':coachName'] = coachName; }
      else { removeClauses.push('coachId', 'coachName'); }
      const updateExpression = `SET ${setClauses.join(', ')}` + (removeClauses.length ? ` REMOVE ${removeClauses.join(', ')}` : '');

      await Promise.all(futureItems.map((f) => ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: { PK: f.PK, SK: 'METADATA' },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { '#loc': 'location' },
        ExpressionAttributeValues: values,
      }))));
      instancesCreated = futureItems.length;
    }
  }

  return json(200, { success: true, id, instancesCreated, registeredCount });
}
