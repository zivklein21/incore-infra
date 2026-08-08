import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand, QueryCommand, UpdateCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { israelDateStr, validatePrivateFields } from '../lib/entities';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// POST /saveClassSeries
// Auth: Cognito JWT, caller must be admin
// Body: { classId, date (ISO), capacity, durationMin, repeatWeekly, allowWaitlist, notes, className?,
//          isPrivate?, allowedMemberIds? }
//
// isPrivate/allowedMemberIds follow the same validation as updateClass.ts
// (see validatePrivateFields()) and are propagated to every future sibling
// via propUpdate below, same as every other field here.
//
// "Apply to all future occurrences" — updates classId itself, then every
// other class sharing its series_id with a date after classId's *original*
// date, applying the same field changes and shifting each one's
// time-of-day to match the new payload (their own day is left alone — this
// is a time-of-day change, not a bulk reschedule to one date). Only classId
// itself triggers reschedule notifications, matching the old Firestore
// saveAllFuture (future siblings' own booked members were never notified
// either — worth revisiting, but this preserves existing behavior exactly).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: {
    classId?: unknown; date?: unknown; capacity?: unknown; durationMin?: unknown;
    repeatWeekly?: unknown; allowWaitlist?: unknown; notes?: unknown; className?: unknown;
    isPrivate?: unknown; allowedMemberIds?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const newDate = typeof body.date === 'string' ? new Date(body.date) : null;
  if (!classId || !newDate || Number.isNaN(newDate.getTime())) {
    return json(400, { error: 'missing_fields', required: ['classId', 'date'] });
  }

  const currentRes = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
  }));
  const current = currentRes.Item as (ClassItem & { series_id?: string }) | undefined;
  if (!current) return json(404, { error: 'class_not_found' });

  const originalDate = new Date(current.date);
  const dateChanged = newDate.getTime() !== originalDate.getTime();
  const seriesId = current.series_id;

  // Resolves to the isPrivate value classId (and every future sibling) ends
  // up with — see updateClass.ts's identical willBePrivate comment.
  const willBePrivate = typeof body.isPrivate === 'boolean' ? body.isPrivate : current.isPrivate === true;

  const propUpdate: Record<string, unknown> = {};
  if (willBePrivate) {
    // A private class is a one-on-one slot — capacity is always exactly 1,
    // propagated to every future sibling the same as every other field here.
    propUpdate.capacity = 1;
  } else if (typeof body.capacity === 'number') {
    propUpdate.capacity = body.capacity;
  }
  if (typeof body.durationMin === 'number') propUpdate.duration_min = body.durationMin;
  if (typeof body.repeatWeekly === 'boolean') propUpdate.repeat_weekly = body.repeatWeekly;
  if (typeof body.allowWaitlist === 'boolean') propUpdate.isWaitlistEnabled = body.allowWaitlist;
  if (typeof body.notes === 'string') propUpdate.notes = body.notes;
  if (typeof body.className === 'string' && body.className.trim()) propUpdate.className = body.className.trim();

  const effectiveCapacity = willBePrivate
    ? 1
    : (typeof body.capacity === 'number' && body.capacity > 0 ? body.capacity : (current.capacity ?? 5));

  if (typeof body.isPrivate === 'boolean') {
    if (body.isPrivate) {
      const privateFields = validatePrivateFields(true, body.allowedMemberIds, effectiveCapacity, current.allowedMemberIds);
      if (!privateFields.ok) return json(400, { error: privateFields.error });
      propUpdate.isPrivate = true;
      propUpdate.allowedMemberIds = privateFields.allowedMemberIds;
    } else {
      propUpdate.isPrivate = false;
      propUpdate.allowedMemberIds = [];
    }
  } else if (body.allowedMemberIds !== undefined) {
    if (!current.isPrivate) return json(400, { error: 'not_private' });
    const privateFields = validatePrivateFields(true, body.allowedMemberIds, effectiveCapacity, current.allowedMemberIds);
    if (!privateFields.ok) return json(400, { error: privateFields.error });
    propUpdate.allowedMemberIds = privateFields.allowedMemberIds;
  }

  // ── Update classId itself ─────────────────────────────────────────────────
  const setClauses = ['#date = :date', 'GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk', ...Object.keys(propUpdate).map((k) => `${k} = :${k}`)];
  const values: Record<string, unknown> = {
    ':date': newDate.toISOString(),
    ':gsi2pk': `CLASSDATE#${israelDateStr(newDate)}`,
    ':gsi2sk': `CLASS#${classId}`,
    ...Object.fromEntries(Object.entries(propUpdate).map(([k, v]) => [`:${k}`, v])),
  };
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
    UpdateExpression: `SET ${setClauses.join(', ')}`,
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: values,
  }));

  // ── Shift + update future series siblings ────────────────────────────────
  let futureUpdatedCount = 0;
  if (seriesId) {
    const seriesRes = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND series_id = :seriesId',
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA', ':seriesId': seriesId },
    }));
    const futureItems = ((seriesRes.Items ?? []) as (ClassItem & { PK: string; series_id?: string })[])
      .filter((c) => c.PK !== `CLASS#${classId}` && new Date(c.date).getTime() > originalDate.getTime());

    for (const item of futureItems) {
      const ownDate = new Date(item.date);
      const shifted = new Date(ownDate);
      shifted.setHours(newDate.getHours(), newDate.getMinutes(), 0, 0);

      const siblingId = item.PK.replace('CLASS#', '');
      const siblingSet = ['#date = :date', 'GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk', ...Object.keys(propUpdate).map((k) => `${k} = :${k}`)];
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: item.PK, SK: 'METADATA' },
        UpdateExpression: `SET ${siblingSet.join(', ')}`,
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':date': shifted.toISOString(),
          ':gsi2pk': `CLASSDATE#${israelDateStr(shifted)}`,
          ':gsi2sk': `CLASS#${siblingId}`,
          ...Object.fromEntries(Object.entries(propUpdate).map(([k, v]) => [`:${k}`, v])),
        },
      }));
      futureUpdatedCount++;
    }
  }

  // ── Notify booked members of classId if its date changed ────────────────
  if (dateChanged) {
    const regsRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    }));
    const bookedMemberIds = ((regsRes.Items ?? []) as RegistrationItem[]).map((r) => r.userId).filter(Boolean);

    const className = (propUpdate.className as string | undefined) ?? current.className ?? '';
    const dateStr = newDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Jerusalem' });
    const timeStr = newDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' });
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    await Promise.all(bookedMemberIds.map((memberId) => ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${memberId}`,
        SK: `MESSAGE#${randomUUID()}`,
        type: 'update',
        title: 'Schedule Change',
        body: `${className} has been rescheduled to ${dateStr} at ${timeStr}.`,
        classId,
        className,
        classDate: newDate.toISOString(),
        createdAt: now,
        expiresAt,
        requiresAction: false,
        read: false,
      },
    }))));
  }

  return json(200, { success: true, futureUpdatedCount });
}
