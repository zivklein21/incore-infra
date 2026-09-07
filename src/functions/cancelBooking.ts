import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, RegistrationItem, MemberProfileItem, MembershipItem } from '../lib/entities';
import { evaluateCancellationPolicy } from '../lib/cancellationPolicy';
import { notifyAdmins } from '../lib/adminNotify';
import { maybeSendSoleAttendeeAlert } from '../lib/soleAttendeeAlert';

// POST /cancelBooking
// Body: { classId: string, cancellationReason?: string }
// Auth: Cognito JWT
//
// See functions/src/cancellation.ts for the full legal-cancel policy
// rationale (evaluateCancellationPolicy in lib/cancellationPolicy.ts is the
// ported version, shared with cancelPolicyPreview).
//
// NOTE ported as-is from the original: a LEGAL cancellation credits
// wallet.extraPunches +1 unconditionally (even for MEMBERSHIP-sourced
// bookings, on top of restoring the membership slot), and for ADMIN_CARD
// specifically ALSO credits the originating punch card +1 — i.e. both the
// flat wallet counter and the card get credited. That looks like it may be
// an intentional "bonus" or a pre-existing double-credit; flagged, not
// changed, per the instruction to preserve business logic exactly.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { classId?: unknown; cancellationReason?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const cancellationReason = typeof body.cancellationReason === 'string' ? body.cancellationReason : 'other';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const regKey = { PK: `CLASS#${classId}`, SK: `REG#${uid}` };
  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const walletKey = { PK: `MEMBER#${uid}`, SK: 'WALLET#PRIMARY' };
  const cancelKey = { PK: `MEMBER#${uid}`, SK: `CANCEL#${classId}` };

  const [regRes, classRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: regKey })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey })),
  ]);

  const regData = regRes.Item as RegistrationItem | undefined;
  if (!regData) return json(400, { error: 'not_booked' });
  if (regData.status !== 'REGISTERED') return json(400, { error: 'already_cancelled' });
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  const policy = await evaluateCancellationPolicy(uid, regData, classItem);
  const cancelStatus = policy.isLegal ? 'LEGALLY_CANCELLED' : 'LATE_CANCELLED';
  const isMembershipBased = regData.consumedFrom === 'MEMBERSHIP' || regData.consumedFrom === 'FUTURE_SUBSCRIPTION';
  const membershipKey = regData.membershipId
    ? { PK: `MEMBER#${uid}`, SK: `MEMBERSHIP#${regData.targetMonth}#${regData.membershipId}` }
    : null;

  // Pre-check whether the specific admin card still exists, so the credit
  // step below can be included/omitted the same way the original's
  // array .map() silently no-op'd for a since-deleted card.
  let adminCardExists = false;
  if (policy.isLegal && regData.consumedFrom === 'ADMIN_CARD' && regData.adminCardId) {
    const cardRes = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${uid}`, SK: `PUNCHCARD#${regData.adminCardId}` },
    }));
    adminCardExists = !!cardRes.Item;
  }

  // ADD on usage.* / weeklyUsage.* requires those maps to already exist on the
  // item — a legacy/imported membership record missing either would throw a
  // ValidationException that aborts the WHOLE transaction, blocking the
  // member from cancelling their own booking at all. Skip the membership
  // counter update rather than let a bookkeeping field take down the cancel.
  let membershipUsable = false;
  if (membershipKey && isMembershipBased) {
    const membershipRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: membershipKey }));
    const membership = membershipRes.Item as MembershipItem | undefined;
    membershipUsable = !!membership?.usage && !!membership.weeklyUsage;
  }

  const nowIso = new Date().toISOString();
  const cancelPayload: Record<string, unknown> = {
    PK: cancelKey.PK,
    SK: cancelKey.SK,
    classId,
    status: cancelStatus,
    consumedFrom: regData.consumedFrom ?? '',
    membershipId: regData.membershipId ?? '',
    adminCardId: regData.adminCardId ?? null,
    weekKey: regData.weekKey ?? null,
    targetMonth: regData.targetMonth ?? '',
    cancelledAt: nowIso,
    cancellationReason: cancellationReason ?? null,
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

  if (policy.isLegal) {
    if (membershipKey && membershipUsable) {
      const wKey = regData.weekKey;
      transactItems.push({
        Update: {
          TableName: TABLE_NAME,
          Key: membershipKey,
          // usage is a DynamoDB reserved keyword — bare here it fails every call.
          UpdateExpression: wKey
            ? 'ADD #usage.legalCancellationsUsed :one, #usage.totalMonthlyUsed :negOne, weeklyUsage.#wk :negOne SET updatedAt = :now'
            : 'ADD #usage.legalCancellationsUsed :one, #usage.totalMonthlyUsed :negOne SET updatedAt = :now',
          ExpressionAttributeNames: wKey ? { '#wk': wKey, '#usage': 'usage' } : { '#usage': 'usage' },
          ExpressionAttributeValues: { ':one': 1, ':negOne': -1, ':now': nowIso },
        },
      });
    }

    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: walletKey,
        UpdateExpression: 'ADD extraPunches :one SET updatedAt = :now',
        ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
      },
    });

    if (regData.consumedFrom === 'ADMIN_CARD' && regData.adminCardId && adminCardExists) {
      transactItems.push({
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: `MEMBER#${uid}`, SK: `PUNCHCARD#${regData.adminCardId}` },
          UpdateExpression: 'ADD remainingPunches :one',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':one': 1 },
        },
      });
    }
  } else if (membershipKey && membershipUsable) {
    const wKey = regData.weekKey;
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: membershipKey,
        // usage is a DynamoDB reserved keyword — bare here it fails every call.
        UpdateExpression: wKey
          ? 'ADD #usage.lateCancellationsUsed :one, weeklyUsage.#wk :negOne SET updatedAt = :now'
          : 'ADD #usage.lateCancellationsUsed :one SET updatedAt = :now',
        ExpressionAttributeNames: wKey ? { '#wk': wKey, '#usage': 'usage' } : { '#usage': 'usage' },
        ExpressionAttributeValues: { ':one': 1, ':negOne': -1, ':now': nowIso },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err: any) {
    if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
      return json(400, { error: 'already_cancelled' });
    }
    console.error('[cancelBooking] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  console.log(`[cancelBooking] uid=${uid} class=${classId} status=${cancelStatus} isLegal=${policy.isLegal} lateReason=${policy.lateReason ?? 'none'}`);

  if (!policy.isLegal && policy.remainingAfterCancel === 1) {
    try {
      await sendDropoutAlert(classId, classItem);
    } catch (err: any) {
      console.error('[cancelBooking] dropout alert failed (non-fatal):', err);
    }
  }

  try {
    await maybeSendSoleAttendeeAlert(classId, classItem, policy.remainingAfterCancel);
  } catch (err: any) {
    console.error('[cancelBooking] sole-attendee alert failed (non-fatal):', err);
  }

  return json(200, {
    success: true,
    cancellationStatus: cancelStatus,
    isLegal: policy.isLegal,
    policy: {
      hoursUntilClass: Math.round(policy.hoursUntilClass * 10) / 10,
      cancelWindowHours: 24,
      remainingAfterCancel: policy.remainingAfterCancel,
      minTraineesRequired: 2,
      isTimeOk: policy.isTimeOk,
      isOccupancyOk: policy.isOccupancyOk,
      isQuotaOk: policy.isQuotaOk,
      allowedLegalCancellationsPerMonth: policy.allowedLegalCancellationsPerMonth,
      lateReason: policy.lateReason,
    },
  });
}

async function sendDropoutAlert(classId: string, classItem: ClassItem): Promise<void> {
  const remainingRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :registered',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
  }));
  const remaining = (remainingRes.Items ?? [])[0] as RegistrationItem | undefined;
  if (!remaining) return;

  const lastTraineeId = remaining.userId;
  const memberRes = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${lastTraineeId}`, SK: 'PROFILE' },
  }));
  const lastTraineeName = (memberRes.Item as MemberProfileItem | undefined)?.name ?? '';
  const className = classItem.className ?? '';
  const classDateStr = new Date(classItem.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const message = `On ${classDateStr} ${lastTraineeName} was left alone in the class!`;

  await notifyAdmins({
    type: 'CRITICAL_CLASS_DROPOUT',
    priority: 'HIGH',
    pushTitle: 'Critical Alert:',
    message,
    extra: { classId, className, classTimestamp: classItem.date, lastTraineeId, lastTraineeName },
  });

  console.log(`[cancelBooking] dropout alert dispatched: class=${classId} lastTrainee=${lastTraineeId}`);
}
