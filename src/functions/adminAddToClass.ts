import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey, computeWeekKey, type ClassItem, type MembershipItem } from '../lib/entities';

// POST /adminAddToClass
// Body: { classId, userId, deductSession: boolean }
// Auth: Cognito JWT, caller must be admin
//
// deductSession=true  → counts against the member's active membership quota
//                        (consumedFrom: MEMBERSHIP, weeklyUsage/totalMonthlyUsed incremented)
// deductSession=false → admin override, no quota tracking (consumedFrom: ADMIN_CARD)
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; userId?: unknown; deductSession?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const deductSession = body.deductSession === true;
  if (!classId || !userId) return json(400, { error: 'missing_fields', required: ['classId', 'userId'] });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey }));
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });
  if ((classItem.currentAttendeesCount ?? 0) >= (classItem.capacity ?? 5)) return json(400, { error: 'class_full' });

  const classDate = new Date(classItem.date);
  const targetMonth = monthKey(classDate);
  const wKey = computeWeekKey(classDate);

  let membershipId = '';
  let activeMembership: MembershipItem | undefined;
  if (deductSession) {
    const membRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${userId}`, ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE' },
    }));
    activeMembership = (membRes.Items ?? [])[0] as MembershipItem | undefined;
    membershipId = activeMembership?.membershipId ?? '';
  }

  const nowIso = new Date().toISOString();
  const regKey = { PK: `CLASS#${classId}`, SK: `REG#${userId}` };

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: regKey.PK,
          SK: regKey.SK,
          GSI1PK: `MEMBER#${userId}`,
          GSI1SK: `REG#${targetMonth}#${classId}`,
          userId,
          classId,
          classDate: classItem.date,
          status: 'REGISTERED',
          targetMonth,
          weekKey: wKey,
          consumedFrom: deductSession ? 'MEMBERSHIP' : 'ADMIN_CARD',
          membershipId,
          registeredAt: nowIso,
        },
        ConditionExpression: 'attribute_not_exists(PK) OR #status <> :registered',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':registered': 'REGISTERED' },
      },
    },
    {
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

  if (deductSession && activeMembership) {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: `MEMBERSHIP#${activeMembership.targetMonth}#${activeMembership.membershipId}` },
        // usage is a DynamoDB reserved keyword — bare here it fails every call.
        UpdateExpression: 'ADD #usage.totalMonthlyUsed :one, weeklyUsage.#wk :one',
        ExpressionAttributeNames: { '#wk': wKey, '#usage': 'usage' },
        ExpressionAttributeValues: { ':one': 1 },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err: any) {
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons?.map((r) => r.Code) ?? [];
      if (reasons[0] === 'ConditionalCheckFailed') return json(400, { error: 'already_booked' });
      if (reasons[1] === 'ConditionalCheckFailed') return json(400, { error: 'class_full' });
      return json(400, { error: 'transaction_failed' });
    }
    console.error('[adminAddToClass] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  return json(200, { success: true });
}
