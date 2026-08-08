import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { RegistrationItem, ClassItem } from '../lib/entities';
import { maybeSendSoleAttendeeAlert } from '../lib/soleAttendeeAlert';

// POST /adminCancelRegistration
// Body: { userId, classId, refundTo: 'none' | 'wallet' | 'membership' }
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { userId?: unknown; classId?: unknown; refundTo?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const requestedRefundTo = body.refundTo === 'wallet' || body.refundTo === 'membership' ? (body.refundTo as 'wallet' | 'membership') : 'none';
  if (!userId || !classId) return json(400, { error: 'missing_fields', required: ['userId', 'classId'] });

  const regKey = { PK: `CLASS#${classId}`, SK: `REG#${userId}` };
  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const walletKey = { PK: `MEMBER#${userId}`, SK: 'WALLET#PRIMARY' };
  const cancelKey = { PK: `MEMBER#${userId}`, SK: `CANCEL#${classId}` };

  const [regRes, classRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: regKey })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey })),
  ]);
  const regData = regRes.Item as RegistrationItem | undefined;
  if (!regData) return json(400, { error: 'not_booked' });
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(400, { error: 'class_not_found' });
  if (regData.status !== 'REGISTERED') return json(400, { error: 'already_cancelled' });

  // Trial registrations never consumed a wallet punch or membership slot —
  // ignore whatever the caller requested and always treat as a plain removal.
  const refundTo = regData.consumedFrom === 'TRIAL' ? 'none' : requestedRefundTo;

  const nowIso = new Date().toISOString();
  const cancelPayload: Record<string, unknown> = {
    PK: cancelKey.PK,
    SK: cancelKey.SK,
    classId,
    status: 'ADMIN_CANCELLED',
    consumedFrom: regData.consumedFrom ?? '',
    membershipId: regData.membershipId ?? '',
    adminCardId: regData.adminCardId ?? null,
    weekKey: regData.weekKey ?? null,
    targetMonth: regData.targetMonth ?? '',
    cancelledAt: nowIso,
    adminCancelled: true,
    refundTo,
  };

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Delete: {
        TableName: TABLE_NAME,
        Key: regKey,
        ConditionExpression: '#status = :registered',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':registered': 'REGISTERED' },
      },
    },
    { Put: { TableName: TABLE_NAME, Item: cancelPayload } },
    {
      Update: {
        TableName: TABLE_NAME,
        Key: classKey,
        UpdateExpression: 'ADD currentAttendeesCount :negOne',
        ExpressionAttributeValues: { ':negOne': -1 },
      },
    },
  ];

  if (refundTo === 'wallet') {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: walletKey,
        UpdateExpression: 'ADD extraPunches :one SET updatedAt = :now',
        ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
      },
    });
  }

  if (refundTo === 'membership' && regData.membershipId) {
    const wKey = regData.weekKey;
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: `MEMBERSHIP#${regData.targetMonth}#${regData.membershipId}` },
        // usage is a DynamoDB reserved keyword — bare here it fails every call.
        UpdateExpression: wKey
          ? 'ADD #usage.totalMonthlyUsed :negOne, weeklyUsage.#wk :negOne SET updatedAt = :now'
          : 'ADD #usage.totalMonthlyUsed :negOne SET updatedAt = :now',
        ExpressionAttributeNames: wKey ? { '#wk': wKey, '#usage': 'usage' } : { '#usage': 'usage' },
        ExpressionAttributeValues: { ':negOne': -1, ':now': nowIso },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err: any) {
    if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
      return json(400, { error: 'already_cancelled' });
    }
    console.error('[adminCancelRegistration] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  console.log(`[adminCancelRegistration] admin=${callerUid} user=${userId} class=${classId} refundTo=${refundTo}`);

  const remainingAfterCancel = Math.max(0, (classItem.currentAttendeesCount ?? 0) - 1);
  try {
    await maybeSendSoleAttendeeAlert(classId, classItem, remainingAfterCancel);
  } catch (err: any) {
    console.error('[adminCancelRegistration] sole-attendee alert failed (non-fatal):', err);
  }

  return json(200, { success: true, refundTo });
}
