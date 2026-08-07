import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey, computeWeekKey, israelDateStr, type ClassItem, type MembershipItem, type WalletItem, type PunchCardItem } from '../lib/entities';

type ConsumedFrom = 'MEMBERSHIP' | 'EXTRA_PUNCH' | 'ADMIN_CARD';

// Same priority as bookClass.ts/confirmWaitlistSpot.ts's own copies of this
// helper (each handler keeps its own small local copy rather than sharing
// one lib function — see those two files): prefer the oldest-first ordering
// implied by the query, first non-expired card with punches left.
function findAvailableAdminCard(cards: PunchCardItem[], classDate: Date): PunchCardItem | null {
  return cards.find((c) => {
    if (c.remainingPunches <= 0) return false;
    if (c.expiryDate && new Date(c.expiryDate) < classDate) return false;
    return true;
  }) ?? null;
}

// POST /adminAddToClass
// Body: { classId, userId, deductSession: boolean, skipSameDayCheck?: boolean, useWalletCredit?: boolean }
// Auth: Cognito JWT, caller must be admin
//
// deductSession=true   → counts against the member's active membership quota
//                         (consumedFrom: MEMBERSHIP, weeklyUsage/totalMonthlyUsed incremented)
// deductSession=false,
//   useWalletCredit=true  → spends a real credit: the member's wallet
//                            extraPunches first, else an available admin
//                            punch card (consumedFrom: EXTRA_PUNCH/ADMIN_CARD,
//                            same priority as confirmWaitlistSpot.ts)
//   useWalletCredit=false → free admin override, nothing deducted anywhere
//                            (consumedFrom: ADMIN_CARD, no adminCardId set —
//                            this is what distinguishes it from a real punch
//                            card consumption, which always carries one)
//
// Two non-fatal warnings can short-circuit the write and come back as a 200
// with a `warning` field instead of the usual { success: true }, so the
// client can show an "Add Anyway" prompt rather than treating this like an
// error:
//   - ALREADY_BOOKED_SAME_DAY: userId already has a REGISTERED reg on another
//     class the same calendar day (mirrors bookClass.ts's own-booking check).
//     Resubmit with skipSameDayCheck: true to proceed anyway — confirm-then-
//     retry shape borrowed from adminApproveWaitlist.ts's skipLimitCheck.
//   - WEEKLY_QUOTA_EXCEEDED: deductSession=true and the active membership's
//     weekly quota is already used up. There is deliberately no skip flag for
//     this one — a membership can never be pushed over its weekly quota by
//     admin override. To "add anyway" the client resubmits with
//     deductSession: false instead (optionally with useWalletCredit: true),
//     which leaves the membership's usage untouched.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; userId?: unknown; deductSession?: unknown; skipSameDayCheck?: unknown; useWalletCredit?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const deductSession = body.deductSession === true;
  const skipSameDayCheck = body.skipSameDayCheck === true;
  const useWalletCredit = body.useWalletCredit === true;
  if (!classId || !userId) return json(400, { error: 'missing_fields', required: ['classId', 'userId'] });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey }));
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });
  if ((classItem.currentAttendeesCount ?? 0) >= (classItem.capacity ?? 5)) return json(400, { error: 'class_full' });

  const classDate = new Date(classItem.date);
  const targetMonth = monthKey(classDate);
  const wKey = computeWeekKey(classDate);

  if (!skipSameDayCheck) {
    try {
      const dateStr = israelDateStr(classDate);
      const sameDayRes = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `CLASSDATE#${dateStr}` },
      }));
      const otherClassIds = (sameDayRes.Items ?? [])
        .map((item) => (item.GSI2SK as string).replace('CLASS#', ''))
        .filter((id) => id !== classId);
      const regChecks = await Promise.all(
        otherClassIds.map((id) =>
          ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${id}`, SK: `REG#${userId}` } })),
        ),
      );
      const alreadyBookedSameDay = regChecks.some((r) => (r.Item as { status?: string } | undefined)?.status === 'REGISTERED');
      if (alreadyBookedSameDay) {
        return json(200, {
          warning: 'ALREADY_BOOKED_SAME_DAY',
          message: 'המתאמן כבר רשום לאימון נוסף באותו היום',
        });
      }
    } catch (err) {
      console.error('[adminAddToClass] same-day check error', err);
    }
  }

  let membershipId = '';
  let activeMembership: MembershipItem | undefined;
  let consumedFrom: ConsumedFrom = 'ADMIN_CARD'; // free admin override unless one of the branches below sets a real source
  let adminCardId = '';

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

    if (activeMembership) {
      const weeklyLimit = activeMembership.weeklyLimit ?? 0;
      const bookedThisWeek = activeMembership.weeklyUsage?.[wKey] ?? 0;
      if (weeklyLimit > 0 && bookedThisWeek >= weeklyLimit) {
        return json(200, {
          warning: 'WEEKLY_QUOTA_EXCEEDED',
          message: 'למתאמן נגמרה המכסה השבועית',
          bookedThisWeek,
          weeklyLimit,
        });
      }
    }
    consumedFrom = 'MEMBERSHIP';
  } else if (useWalletCredit) {
    const [walletRes, cardsRes] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${userId}`, SK: 'WALLET#PRIMARY' } })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `MEMBER#${userId}`, ':prefix': 'PUNCHCARD#' },
      })),
    ]);
    const extraPunches = (walletRes.Item as WalletItem | undefined)?.extraPunches ?? 0;
    const adminPunchCards = (cardsRes.Items ?? []) as PunchCardItem[];

    if (extraPunches > 0) {
      consumedFrom = 'EXTRA_PUNCH';
    } else {
      const card = findAvailableAdminCard(adminPunchCards, classDate);
      if (!card) return json(400, { error: 'no_credits' });
      consumedFrom = 'ADMIN_CARD';
      adminCardId = card.cardId;
    }
  }

  const nowIso = new Date().toISOString();
  const regKey = { PK: `CLASS#${classId}`, SK: `REG#${userId}` };

  const registrationPayload: Record<string, unknown> = {
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
    consumedFrom,
    membershipId,
    registeredAt: nowIso,
  };
  if (adminCardId) registrationPayload.adminCardId = adminCardId;

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: registrationPayload,
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

  // Registration (index 0) and capacity (index 1) are always present; the
  // balance item's index depends on whether a membership item was pushed
  // above, so it's captured here rather than hardcoded for the
  // CancellationReasons check below — same approach as bookClass.ts.
  let balanceItemIndex = -1;
  if (consumedFrom === 'EXTRA_PUNCH') {
    balanceItemIndex = transactItems.length;
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: 'WALLET#PRIMARY' },
        UpdateExpression: 'ADD extraPunches :negOne',
        ConditionExpression: 'extraPunches > :zero',
        ExpressionAttributeValues: { ':negOne': -1, ':zero': 0 },
      },
    });
  } else if (consumedFrom === 'ADMIN_CARD' && adminCardId) {
    balanceItemIndex = transactItems.length;
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${userId}`, SK: `PUNCHCARD#${adminCardId}` },
        UpdateExpression: 'ADD remainingPunches :negOne',
        ConditionExpression: 'attribute_exists(PK) AND remainingPunches > :zero',
        ExpressionAttributeValues: { ':negOne': -1, ':zero': 0 },
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
      if (balanceItemIndex >= 0 && reasons[balanceItemIndex] === 'ConditionalCheckFailed') {
        return json(400, { error: consumedFrom === 'EXTRA_PUNCH' ? 'wallet_not_found' : 'admin_card_depleted' });
      }
      return json(400, { error: 'transaction_failed' });
    }
    console.error('[adminAddToClass] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  return json(200, { success: true, consumedFrom });
}
