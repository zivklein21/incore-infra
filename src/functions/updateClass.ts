import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { israelDateStr, validatePrivateFields } from '../lib/entities';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// POST /updateClass
// Auth: Cognito JWT, caller must be admin
// Body: { classId: string, date?: string (ISO), capacity?: number, className?: string,
//          durationMin?: number, notes?: string, repeatWeekly?: boolean,
//          isWaitlistEnabled?: boolean, detachFromSeries?: boolean,
//          isPrivate?: boolean, allowedMemberIds?: string[] }
//
// isPrivate: true forces capacity to 1 (a private class is a one-on-one
// slot — any body.capacity sent alongside is ignored) and validates/stores
// allowedMemberIds (falling back to the current item's list if this call
// doesn't send a fresh one — see validatePrivateFields()); isPrivate: false
// clears both fields so a later re-enable can't silently resurrect a stale
// list. Sending allowedMemberIds without isPrivate on a class that isn't
// already private is rejected (editing an allow-list on a public class is
// meaningless).
//
// Partial update — only fields present in the body are changed. If date
// changes, GSI2PK/GSI2SK are recomputed and rewritten too (see
// createClass.ts). If date actually changes, every REGISTERED member is
// sent a reschedule notification (PK=MEMBER#<uid> SK=MESSAGE#<id> —
// same item shape onMessageCreated.ts's stream trigger already handles,
// see subscriptionExpiryAlert.ts for the same pattern), matching the old
// Firestore saveClass's behavior. Does not touch currentAttendeesCount or
// waitlist.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: {
    classId?: unknown; date?: unknown; capacity?: unknown;
    className?: unknown; isWaitlistEnabled?: unknown; durationMin?: unknown;
    notes?: unknown; repeatWeekly?: unknown; detachFromSeries?: unknown;
    isPrivate?: unknown; allowedMemberIds?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const currentRes = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
  }));
  const current = currentRes.Item as ClassItem | undefined;
  if (!current) return json(404, { error: 'class_not_found' });

  const setClauses: string[] = ['updatedAt = :updatedAt', 'updatedBy = :updatedBy'];
  const removeClauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ':updatedAt': new Date().toISOString(),
    ':updatedBy': uid,
  };

  let newDate: Date | null = null;
  if (typeof body.date === 'string' && body.date) {
    newDate = new Date(body.date);
    if (Number.isNaN(newDate.getTime())) return json(400, { error: 'invalid_date' });
    setClauses.push('#date = :date', 'GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk');
    names['#date'] = 'date';
    values[':date'] = newDate.toISOString();
    values[':gsi2pk'] = `CLASSDATE#${israelDateStr(newDate)}`;
    values[':gsi2sk'] = `CLASS#${classId}`;
  }
  // Resolves to the isPrivate value this update leaves the item with —
  // either what this call explicitly sets, or (if this call doesn't touch
  // isPrivate) whatever the item already has. Computed up front so both the
  // capacity-forcing block below and the allow-list block further down
  // agree on it.
  const willBePrivate = typeof body.isPrivate === 'boolean' ? body.isPrivate : current.isPrivate === true;

  if (willBePrivate) {
    // A private class is a one-on-one slot — capacity is always exactly 1,
    // regardless of what the client sent, so it can't be bypassed by
    // calling this endpoint directly with a stale/tampered capacity.
    setClauses.push('#cap = :capacity');
    names['#cap'] = 'capacity';
    values[':capacity'] = 1;
  } else if (typeof body.capacity === 'number' && body.capacity > 0) {
    // capacity is a DynamoDB reserved keyword — bare here it fails every
    // call with ValidationException, same as the bare `capacity` in
    // bookClass.ts/swapClass.ts/confirmWaitlistSpot.ts/adminAddToClass.ts's
    // ConditionExpressions.
    setClauses.push('#cap = :capacity');
    names['#cap'] = 'capacity';
    values[':capacity'] = body.capacity;
  }
  if (typeof body.className === 'string' && body.className.trim()) {
    setClauses.push('className = :className');
    values[':className'] = body.className.trim();
  }
  if (typeof body.isWaitlistEnabled === 'boolean') {
    setClauses.push('isWaitlistEnabled = :isWaitlistEnabled');
    values[':isWaitlistEnabled'] = body.isWaitlistEnabled;
  }
  if (typeof body.durationMin === 'number' && body.durationMin > 0) {
    setClauses.push('duration_min = :durationMin');
    values[':durationMin'] = body.durationMin;
  }
  if (typeof body.notes === 'string') {
    setClauses.push('notes = :notes');
    values[':notes'] = body.notes;
  }
  if (typeof body.repeatWeekly === 'boolean') {
    setClauses.push('repeat_weekly = :repeatWeekly');
    values[':repeatWeekly'] = body.repeatWeekly;
  }
  if (body.detachFromSeries === true) {
    removeClauses.push('series_id');
  }

  const effectiveCapacity = willBePrivate
    ? 1
    : (typeof body.capacity === 'number' && body.capacity > 0 ? body.capacity : (current.capacity ?? 5));

  if (typeof body.isPrivate === 'boolean') {
    if (body.isPrivate) {
      const privateFields = validatePrivateFields(true, body.allowedMemberIds, effectiveCapacity, current.allowedMemberIds);
      if (!privateFields.ok) return json(400, { error: privateFields.error });
      setClauses.push('isPrivate = :isPrivate', 'allowedMemberIds = :allowedMemberIds');
      values[':isPrivate'] = true;
      values[':allowedMemberIds'] = privateFields.allowedMemberIds;
    } else {
      removeClauses.push('isPrivate', 'allowedMemberIds');
    }
  } else if (body.allowedMemberIds !== undefined) {
    if (!current.isPrivate) return json(400, { error: 'not_private' });
    const privateFields = validatePrivateFields(true, body.allowedMemberIds, effectiveCapacity, current.allowedMemberIds);
    if (!privateFields.ok) return json(400, { error: privateFields.error });
    setClauses.push('allowedMemberIds = :allowedMemberIds');
    values[':allowedMemberIds'] = privateFields.allowedMemberIds;
  }

  const updateExpression = [
    setClauses.length ? `SET ${setClauses.join(', ')}` : '',
    removeClauses.length ? `REMOVE ${removeClauses.join(', ')}` : '',
  ].filter(Boolean).join(' ');

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
      UpdateExpression: updateExpression,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return json(404, { error: 'class_not_found' });
    throw err;
  }

  const dateChanged = newDate !== null && newDate.getTime() !== new Date(current.date).getTime();
  if (dateChanged && newDate) {
    const regsRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    }));
    const bookedMemberIds = ((regsRes.Items ?? []) as RegistrationItem[]).map((r) => r.userId).filter(Boolean);

    const className = typeof values[':className'] === 'string' ? (values[':className'] as string) : (current.className ?? '');
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
        classDate: newDate!.toISOString(),
        createdAt: now,
        expiresAt,
        requiresAction: false,
        read: false,
      },
    }))));
  }

  return json(200, { success: true, classId });
}
