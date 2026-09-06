import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { type ClassItem, type MembershipItem, type WalletItem, type PunchCardItem, monthKey, computeWeekKey, israelDateStr, isMembershipUsableForClass, getEffectiveMonthlyLimit } from '../lib/entities';

// ─── Entity key design (DynamoDB single-table) ─────────────────────────────
//
//   Class          PK=CLASS#<classId>            SK=METADATA
//                  GSI2PK=CLASSDATE#<YYYY-MM-DD>  GSI2SK=CLASS#<classId>
//                  (GSI2PK/SK must be set wherever classes are created —
//                  there is no Cloud Function for that in this migration.)
//   Registration   PK=CLASS#<classId>            SK=REG#<uid>
//                  GSI1PK=MEMBER#<uid>            GSI1SK=REG#<targetMonth>#<classId>
//   Membership     PK=MEMBER#<uid>                SK=MEMBERSHIP#<targetMonth>#<membershipId>
//   Wallet         PK=MEMBER#<uid>                SK=WALLET#PRIMARY
//   PunchCard      PK=MEMBER#<uid>                SK=PUNCHCARD#<cardId>
//                  (split out of the wallet item so a card's remainingPunches
//                  can be decremented with its own ConditionExpression —
//                  TransactWriteItems has no way to conditionally update one
//                  element of an array-of-maps attribute.)

type ConsumedFrom = 'MEMBERSHIP' | 'FUTURE_SUBSCRIPTION' | 'EXTRA_PUNCH' | 'ADMIN_CARD';

function findAvailableAdminCard(cards: PunchCardItem[], classDate: Date): PunchCardItem | null {
  return (
    cards.find((card) => {
      if (card.remainingPunches <= 0) return false;
      if (card.expiryDate && new Date(card.expiryDate) < classDate) return false;
      return true;
    }) ?? null
  );
}

type WalletCreditResult =
  | { consumedFrom: 'EXTRA_PUNCH' | 'ADMIN_CARD'; adminCardId: string }
  | { error: 'no_credits' | 'card_unavailable' };

function resolveWalletCredit(
  extraPunches: number,
  adminPunchCards: PunchCardItem[],
  classDate: Date,
  walletCardId: string | null,
  allowExtraPunch: boolean,
): WalletCreditResult {
  if (walletCardId) {
    if (walletCardId === 'extra_punch') {
      if (!allowExtraPunch || extraPunches <= 0) return { error: 'card_unavailable' };
      return { consumedFrom: 'EXTRA_PUNCH', adminCardId: '' };
    }
    const card = adminPunchCards.find((c) => c.cardId === walletCardId);
    if (!card || card.remainingPunches <= 0) return { error: 'card_unavailable' };
    if (card.expiryDate && new Date(card.expiryDate) < classDate) return { error: 'card_unavailable' };
    return { consumedFrom: 'ADMIN_CARD', adminCardId: card.cardId };
  }

  if (allowExtraPunch && extraPunches > 0) {
    return { consumedFrom: 'EXTRA_PUNCH', adminCardId: '' };
  }
  const card = findAvailableAdminCard(adminPunchCards, classDate);
  if (card) return { consumedFrom: 'ADMIN_CARD', adminCardId: card.cardId };
  return { error: 'no_credits' };
}

// ─── Handler ────────────────────────────────────────────────────────────────
//
// POST /bookClass
// Body: { classId: string, walletCardId?: string }
// Auth: Cognito JWT (validated by API Gateway before this Lambda runs)
//
// Same booking decision tree as the original Firebase function (see git
// history of functions/src/bookClass.ts for the full rationale). Firestore's
// runTransaction() allowed arbitrary reads inside the atomic write; DynamoDB's
// TransactWriteItems does not, so the capacity/balance re-checks that Firestore
// did via tx.get() are done here via ConditionExpressions on each write item
// instead — same race-safety, different mechanism.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { classId?: unknown; walletCardId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const walletCardId = typeof body.walletCardId === 'string' && body.walletCardId ? body.walletCardId : null;
  if (!classId) return json(400, { error: 'missing_class_id' });

  const classPK = `CLASS#${classId}`;
  const regSK = `REG#${uid}`;

  const [classRes, regRes, walletRes, cardsRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: classPK, SK: 'METADATA' } })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: classPK, SK: regSK } })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'WALLET#PRIMARY' } })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'PUNCHCARD#' },
    })),
  ]);

  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  // 404, not 403 — a private class this member isn't allowed into must be
  // indistinguishable from a nonexistent classId (see getClassDetail.ts's
  // same choice). Admins use adminAddToClass, not this self-service path,
  // to add trainees to a private session.
  if (classItem.isPrivate && !(classItem.allowedMemberIds ?? []).includes(uid)) {
    return json(404, { error: 'class_not_found' });
  }

  const existingReg = regRes.Item as { status?: string } | undefined;
  if (existingReg?.status === 'REGISTERED') return json(400, { error: 'already_booked' });

  const capacity = classItem.capacity ?? 5;
  const currentAttendees = classItem.currentAttendeesCount ?? 0;
  if (currentAttendees >= capacity) return json(400, { error: 'class_full' });

  const classDate = new Date(classItem.date);
  const now = new Date();
  const classTargetMonth = monthKey(classDate);
  const currentMonth = monthKey(now);
  const wKey = computeWeekKey(classDate);
  const isFutureBooking = classTargetMonth > currentMonth;

  const extraPunches = (walletRes.Item as WalletItem | undefined)?.extraPunches ?? 0;
  const adminPunchCards = (cardsRes.Items ?? []) as PunchCardItem[];

  const queryMonth = isFutureBooking ? currentMonth : classTargetMonth;
  const membershipsRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': `MEMBERSHIP#${queryMonth}#` },
  }));
  const membership = ((membershipsRes.Items ?? []) as MembershipItem[]).find((m) => isMembershipUsableForClass(m, classDate)) ?? null;

  // A membership whose real endDate already reaches the class date isn't
  // actually "future" from the member's own plan's point of view — it's
  // the same membership they're on today, just being booked ahead of time.
  // This is the normal case for a CUSTOM_MIGRATION bridge, whose endDate
  // commonly extends past the calendar month it's filed under (see
  // adminGrantCustomMigration.ts) — those are never isAutoRenew, so without
  // this check every bridge member would be blocked from booking into any
  // month past the one their record started in, even while still well
  // inside their granted window. Route this case through the normal
  // per-membership consumption below instead of the future-only path.
  const membershipCoversClassDate = !!membership?.endDate && classDate <= new Date(membership.endDate);
  const treatAsFuture = isFutureBooking && !membershipCoversClassDate;

  let consumedFrom: ConsumedFrom;
  let membershipId = '';
  let adminCardId = '';

  if (treatAsFuture) {
    if (!membership) {
      return json(403, { error: 'membership_required', message: 'Future bookings require an active membership for the current month.' });
    }
    if (!membership.isAutoRenew) {
      return json(403, { error: 'auto_renew_required', message: 'Future bookings require an auto-renewing membership.' });
    }

    const futureRes = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: 'consumedFrom = :cf AND #status = :st',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pk': `MEMBER#${uid}`,
        ':prefix': `REG#${classTargetMonth}#`,
        ':cf': 'FUTURE_SUBSCRIPTION',
        ':st': 'REGISTERED',
      },
    }));

    if ((futureRes.Items?.length ?? 0) >= getEffectiveMonthlyLimit(membership)) {
      return json(403, {
        error: 'future_monthly_limit_reached',
        message: `You have reached the maximum booking limit for the next month (${getEffectiveMonthlyLimit(membership)}).`,
      });
    }

    consumedFrom = 'FUTURE_SUBSCRIPTION';
    membershipId = membership.membershipId;
  } else if (membership) {
    const weeklyUsed = membership.weeklyUsage?.[wKey] ?? 0;
    const monthlyUsed = membership.usage?.totalMonthlyUsed ?? 0;
    const withinWeekly = weeklyUsed < membership.weeklyLimit;
    const withinMonthly = monthlyUsed < getEffectiveMonthlyLimit(membership);

    if (withinWeekly && withinMonthly) {
      consumedFrom = 'MEMBERSHIP';
      membershipId = membership.membershipId;
    } else {
      const result = resolveWalletCredit(extraPunches, adminPunchCards, classDate, walletCardId, true);
      if ('error' in result) {
        const overLimitReason = !withinWeekly ? 'weekly_limit_reached' : 'monthly_limit_reached';
        return json(403, {
          error: result.error,
          reason: overLimitReason,
          message: result.error === 'card_unavailable'
            ? 'The selected wallet credit is no longer available.'
            : 'No remaining training credits or membership capacity exceeded.',
        });
      }
      consumedFrom = result.consumedFrom;
      membershipId = membership.membershipId;
      adminCardId = result.adminCardId;
    }
  } else {
    const result = resolveWalletCredit(extraPunches, adminPunchCards, classDate, walletCardId, false);
    if ('error' in result) {
      return json(403, {
        error: 'membership_required',
        message: result.error === 'card_unavailable'
          ? 'The selected wallet credit is no longer available.'
          : 'You do not have an active membership and no available punch cards.',
      });
    }
    consumedFrom = result.consumedFrom;
    adminCardId = result.adminCardId;
  }

  // ── Same-day conflict check (blocking, fail-open on error) ──────────────
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
        ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${id}`, SK: regSK } })),
      ),
    );

    for (const regCheck of regChecks) {
      const status = (regCheck.Item as { status?: string } | undefined)?.status;
      if (status === 'REGISTERED') {
        return json(409, { error: 'same_day_conflict', message: 'You already have a class scheduled for this day' });
      }
    }
  } catch (err: any) {
    console.error('[bookClass] same-day check error', err);
  }

  // ── Atomic transaction ────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const registrationPayload: Record<string, unknown> = {
    PK: classPK,
    SK: regSK,
    GSI1PK: `MEMBER#${uid}`,
    GSI1SK: `REG#${classTargetMonth}#${classId}`,
    userId: uid,
    classId,
    classDate: classItem.date,
    status: 'REGISTERED',
    targetMonth: classTargetMonth,
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
        Key: { PK: classPK, SK: 'METADATA' },
        UpdateExpression: 'ADD currentAttendeesCount :one',
        // capacity is a DynamoDB reserved keyword — used bare here it fails
        // every single call with ValidationException, not just an edge case.
        ConditionExpression: 'currentAttendeesCount < #cap',
        ExpressionAttributeNames: { '#cap': 'capacity' },
        ExpressionAttributeValues: { ':one': 1 },
      },
    },
  ];

  if (membershipId && consumedFrom === 'MEMBERSHIP') {
    // membership.targetMonth (the month the record is actually filed
    // under), not classTargetMonth (the class's own month) — a
    // membershipCoversClassDate booking consumes a membership filed under
    // an earlier month than the class it's paying for, e.g. a
    // CUSTOM_MIGRATION bridge filed under 2026-08 covering a class on
    // 2026-09-10; classTargetMonth here would point at a SK the item was
    // never written under.
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${uid}`, SK: `MEMBERSHIP#${membership!.targetMonth}#${membershipId}` },
        // usage is ALSO a DynamoDB reserved keyword, same class of bug as
        // #cap above.
        UpdateExpression: 'ADD #usage.totalMonthlyUsed :one, weeklyUsage.#wk :one SET updatedAt = :now',
        ExpressionAttributeNames: { '#wk': wKey, '#usage': 'usage' },
        ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
      },
    });
  }

  // Registration (index 0) and capacity (index 1) are always present; the
  // balance item's index depends on whether a membership item was pushed, so
  // it's captured here rather than hardcoded for the CancellationReasons check.
  let balanceItemIndex = -1;
  if (consumedFrom === 'EXTRA_PUNCH') {
    balanceItemIndex = transactItems.length;
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${uid}`, SK: 'WALLET#PRIMARY' },
        UpdateExpression: 'ADD extraPunches :negOne SET updatedAt = :now',
        ConditionExpression: 'extraPunches > :zero',
        ExpressionAttributeValues: { ':negOne': -1, ':zero': 0, ':now': nowIso },
      },
    });
  } else if (consumedFrom === 'ADMIN_CARD') {
    balanceItemIndex = transactItems.length;
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${uid}`, SK: `PUNCHCARD#${adminCardId}` },
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
      const reasons = err.CancellationReasons ?? [];
      const failed = (idx: number) => reasons[idx]?.Code === 'ConditionalCheckFailed';

      if (failed(0)) return json(400, { error: 'already_booked' });
      if (failed(1)) return json(400, { error: 'class_full' });
      if (balanceItemIndex >= 0 && failed(balanceItemIndex)) {
        return json(400, { error: consumedFrom === 'EXTRA_PUNCH' ? 'wallet_not_found' : 'admin_card_depleted' });
      }
    }
    console.error('[bookClass] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  console.log(`[bookClass] uid=${uid} class=${classId} consumedFrom=${consumedFrom} month=${classTargetMonth} week=${wKey}`);

  return json(200, {
    success: true,
    consumedFrom,
    targetMonth: classTargetMonth,
    membershipId: membershipId || null,
  });
}
