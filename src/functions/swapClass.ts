import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { type ClassItem, type RegistrationItem, monthKey, computeWeekKey } from '../lib/entities';

const MIN_TRAINEES_REQUIRED = 2;

// POST /swapClass
// Body: { oldClassId: string, newClassId: string }
// Auth: Cognito JWT (validated by API Gateway before this Lambda runs)
//
// "Green track" swap within the same Sun–Sat week: no quota, wallet, or
// membership counters touched — consumedFrom carries over unchanged. See
// git history of functions/src/swapClass.ts for the full rationale.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { oldClassId?: unknown; newClassId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const oldClassId = typeof body.oldClassId === 'string' ? body.oldClassId.trim() : '';
  const newClassId = typeof body.newClassId === 'string' ? body.newClassId.trim() : '';
  if (!oldClassId || !newClassId) return json(400, { error: 'missing_class_ids' });
  if (oldClassId === newClassId) return json(400, { error: 'same_class' });

  const oldClassKey = { PK: `CLASS#${oldClassId}`, SK: 'METADATA' };
  const newClassKey = { PK: `CLASS#${newClassId}`, SK: 'METADATA' };
  const oldRegKey = { PK: `CLASS#${oldClassId}`, SK: `REG#${uid}` };
  const newRegKey = { PK: `CLASS#${newClassId}`, SK: `REG#${uid}` };

  const [oldClassRes, newClassRes, oldRegRes, newRegRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: oldClassKey })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: newClassKey })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: oldRegKey })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: newRegKey })),
  ]);

  const oldClass = oldClassRes.Item as ClassItem | undefined;
  const newClass = newClassRes.Item as ClassItem | undefined;
  if (!oldClass) return json(400, { error: 'old_class_not_found' });
  if (!newClass) return json(400, { error: 'new_class_not_found' });

  const oldReg = oldRegRes.Item as RegistrationItem | undefined;
  if (!oldReg) return json(400, { error: 'not_booked' });
  if (oldReg.status !== 'REGISTERED') return json(400, { error: 'registration_not_active' });

  const newReg = newRegRes.Item as RegistrationItem | undefined;
  if (newReg?.status === 'REGISTERED') return json(400, { error: 'already_booked_in_new_class' });

  const oldClassDate = new Date(oldClass.date);
  const newClassDate = new Date(newClass.date);

  // 1. Same-week constraint
  const oldWeekKey = computeWeekKey(oldClassDate);
  const newWeekKey = computeWeekKey(newClassDate);
  if (oldWeekKey !== newWeekKey) return json(400, { error: 'different_weeks' });

  // 2. Capacity check on the new class (also re-checked via ConditionExpression below)
  const newCapacity = newClass.capacity ?? 5;
  const newAttendees = newClass.currentAttendeesCount ?? 0;
  if (newAttendees >= newCapacity) return json(400, { error: 'new_class_full' });

  // 3. Studio safety shield — old class must keep >= MIN_TRAINEES_REQUIRED after swap
  const oldAttendees = oldClass.currentAttendeesCount ?? 0;
  if (oldAttendees - 1 < MIN_TRAINEES_REQUIRED) return json(400, { error: 'minimum_occupancy_violation' });

  const nowIso = new Date().toISOString();
  const newRegPayload: Record<string, unknown> = {
    PK: newRegKey.PK,
    SK: newRegKey.SK,
    GSI1PK: `MEMBER#${uid}`,
    GSI1SK: `REG#${monthKey(newClassDate)}#${newClassId}`,
    userId: uid,
    classId: newClassId,
    classDate: newClass.date,
    status: 'REGISTERED',
    targetMonth: monthKey(newClassDate),
    weekKey: newWeekKey,
    consumedFrom: oldReg.consumedFrom,
    membershipId: oldReg.membershipId ?? '',
    registeredAt: nowIso,
    swappedFromClassId: oldClassId,
  };
  if (oldReg.adminCardId) newRegPayload.adminCardId = oldReg.adminCardId;

  // Same rationale as bookClass.ts: TransactWriteItems has no reads, so the
  // validations above are re-asserted here via ConditionExpressions for
  // race-safety under concurrent requests.
  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Update: {
        TableName: TABLE_NAME,
        Key: oldRegKey,
        UpdateExpression: 'SET #status = :swapped, swappedAt = :now, swappedToClassId = :newClassId',
        ConditionExpression: '#status = :registered',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':swapped': 'SWAPPED', ':registered': 'REGISTERED', ':now': nowIso, ':newClassId': newClassId },
      },
    },
    {
      Update: {
        TableName: TABLE_NAME,
        Key: oldClassKey,
        UpdateExpression: 'ADD currentAttendeesCount :negOne',
        ConditionExpression: 'currentAttendeesCount >= :minPlusOne',
        ExpressionAttributeValues: { ':negOne': -1, ':minPlusOne': MIN_TRAINEES_REQUIRED + 1 },
      },
    },
    {
      Put: {
        TableName: TABLE_NAME,
        Item: newRegPayload,
        ConditionExpression: 'attribute_not_exists(PK) OR #status <> :registered',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':registered': 'REGISTERED' },
      },
    },
    {
      Update: {
        TableName: TABLE_NAME,
        Key: newClassKey,
        UpdateExpression: 'ADD currentAttendeesCount :one',
        ConditionExpression: 'currentAttendeesCount < #cap',
        ExpressionAttributeNames: { '#cap': 'capacity' },
        ExpressionAttributeValues: { ':one': 1 },
      },
    },
  ];

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err: any) {
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons ?? [];
      const failed = (idx: number) => reasons[idx]?.Code === 'ConditionalCheckFailed';

      if (failed(0)) return json(400, { error: 'registration_not_active' });
      if (failed(1)) return json(400, { error: 'minimum_occupancy_violation' });
      if (failed(2)) return json(400, { error: 'already_booked_in_new_class' });
      if (failed(3)) return json(400, { error: 'new_class_full' });
    }
    console.error('[swapClass] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  console.log(`[swapClass] uid=${uid} oldClass=${oldClassId} -> newClass=${newClassId}`);

  return json(200, { success: true, swappedFrom: oldClassId, swappedTo: newClassId });
}
