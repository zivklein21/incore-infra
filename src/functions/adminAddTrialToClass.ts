import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey, computeWeekKey, type ClassItem } from '../lib/entities';

// POST /adminAddTrialToClass
// Body: { classId, fullName, overrideCapacity?: boolean }
// Auth: Cognito JWT, caller must be admin
//
// Registers a walk-in trial trainee (no account, no MemberProfileItem) into a
// session. The RegistrationItem's userId is a synthetic `trial_<uuid>` so it
// fits the existing SK=REG#<userId> key shape; fullName is denormalized onto
// the item since there's no profile to resolve a name from later
// (see getClassMembers.ts's consumedFrom === 'TRIAL' branch).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; fullName?: unknown; overrideCapacity?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const overrideCapacity = body.overrideCapacity === true;
  if (!classId || !fullName) return json(400, { error: 'missing_fields', required: ['classId', 'fullName'] });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey }));
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  if (!overrideCapacity && (classItem.currentAttendeesCount ?? 0) >= (classItem.capacity ?? 5)) {
    return json(200, { capacityExceeded: true });
  }

  const classDate = new Date(classItem.date);
  const targetMonth = monthKey(classDate);
  const wKey = computeWeekKey(classDate);

  const trialUserId = `trial_${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const regKey = { PK: `CLASS#${classId}`, SK: `REG#${trialUserId}` };

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: regKey.PK,
          SK: regKey.SK,
          GSI1PK: `MEMBER#${trialUserId}`,
          GSI1SK: `REG#${targetMonth}#${classId}`,
          userId: trialUserId,
          classId,
          classDate: classItem.date,
          status: 'REGISTERED',
          targetMonth,
          weekKey: wKey,
          consumedFrom: 'TRIAL',
          membershipId: '',
          fullName,
          registeredAt: nowIso,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    overrideCapacity
      ? {
          Update: {
            TableName: TABLE_NAME,
            Key: classKey,
            UpdateExpression: 'ADD currentAttendeesCount :one',
            ExpressionAttributeValues: { ':one': 1 },
          },
        }
      : {
          Update: {
            TableName: TABLE_NAME,
            Key: classKey,
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
      const reasons = err.CancellationReasons?.map((r) => r.Code) ?? [];
      if (reasons[1] === 'ConditionalCheckFailed') return json(400, { error: 'class_full' });
      return json(400, { error: 'transaction_failed' });
    }
    console.error('[adminAddTrialToClass] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  return json(200, { success: true });
}
