import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, RegistrationItem, MemberProfileItem } from '../lib/entities';
import { evaluateCancellationPolicy } from '../lib/cancellationPolicy';
import { notifyAdmins } from '../lib/adminNotify';
import { maybeSendSoleAttendeeAlert } from '../lib/soleAttendeeAlert';
import { findRegistrationMembership } from '../lib/registrationMembership';
import { ensureCreditBuckets, addCreditItem } from '../lib/walletCredit';

// POST /cancelBooking
// Body: { classId: string, cancellationReason?: string }
// Auth: Cognito JWT
//
// See functions/src/cancellation.ts for the full legal-cancel policy
// rationale (evaluateCancellationPolicy in lib/cancellationPolicy.ts is the
// ported version, shared with cancelPolicyPreview).
//
// A LEGAL cancellation refunds the session to its own source only
// (membership slot, punch card, or wallet credit). The original port also
// credited wallet.extraPunches +1 on every legal cancellation, on top of
// restoring the source — a double credit, removed 2026-10.
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
  //
  // The membership is looked up by its own filing month, not the booking's —
  // see findRegistrationMembership (a cross-month migration bridge otherwise
  // never gets its slot back).
  let membershipKey: { PK: string; SK: string } | null = null;
  let membershipUsable = false;
  if (isMembershipBased) {
    const found = await findRegistrationMembership(uid, regData);
    if (found) {
      membershipKey = found.key;
      membershipUsable = !!found.item.usage && !!found.item.weeklyUsage;
    }
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

    // The session goes back to where it was paid from — and only there. A
    // membership slot is NOT also credited to the wallet: if it isn't made
    // up, the Thursday job rolls it into credit (within the monthly cap).
    // The wallet only gets it back when the wallet paid for it, or when the
    // punch card it came from has since been deleted. ADMIN_CARD with no
    // adminCardId is a free admin add — nothing was paid, nothing comes back.
    const refundToWallet = regData.consumedFrom === 'EXTRA_PUNCH'
      || (regData.consumedFrom === 'ADMIN_CARD' && !!regData.adminCardId && !adminCardExists);
    if (refundToWallet) {
      await ensureCreditBuckets(uid);
      transactItems.push(addCreditItem(uid, 1, nowIso));
    }

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
        ExpressionAttributeValues: wKey ? { ':one': 1, ':negOne': -1, ':now': nowIso } : { ':one': 1, ':now': nowIso },
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
    brand: 'incore',
    pushTitle: 'Critical Alert:',
    message,
    extra: { classId, className, classTimestamp: classItem.date, lastTraineeId, lastTraineeName },
  });

  console.log(`[cancelBooking] dropout alert dispatched: class=${classId} lastTrainee=${lastTraineeId}`);
}
