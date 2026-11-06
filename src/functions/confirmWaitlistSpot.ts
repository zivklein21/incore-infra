import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { ClassItem, MembershipItem, WalletItem, PunchCardItem } from '../lib/entities';
import { monthKey, computeWeekKey, getEffectiveMonthlyLimit, weeklyUsedAcrossMemberships } from '../lib/entities';
import { chooseCredit, spendFromBucketItem, CREDITS_EXPIRED_MESSAGE } from '../lib/creditSpend';
import { membershipForClass } from '../lib/registrationMembership';

type ConsumedFrom = 'MEMBERSHIP' | 'EXTRA_PUNCH' | 'ADMIN_CARD';

// POST /confirmWaitlistSpot
// Body: { memberId, classId }
// SECURITY NOTE: no auth in the original, ported as-is and flagged.
//
// With the broadcast model, any 'waiting' or 'pending' member can call this
// to atomically claim a free slot — the transaction's capacity check is the
// single arbiter of who gets the spot. Mirrors bookClass.ts's priority order
// and TransactWriteItems/ConditionExpression approach; see that file for the
// fuller rationale on why DynamoDB needs conditions where Firestore used
// transactional reads.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let body: { memberId?: unknown; classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing memberId or classId' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId : '';
  const classId = typeof body.classId === 'string' ? body.classId : '';
  if (!memberId || !classId) return json(400, { error: 'Missing memberId or classId' });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const walletKey = { PK: `MEMBER#${memberId}`, SK: 'WALLET#PRIMARY' };

  const [classRes, walletRes, cardsRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: walletKey })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'PUNCHCARD#' },
    })),
  ]);

  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  const waitlist = classItem.waitlist ?? [];
  const entry = waitlist.find((e) => e.member === memberId && (e.status === 'waiting' || e.status === 'pending'));
  if (!entry) return json(400, { error: 'not_on_waitlist' });

  const classDate = new Date(classItem.date);
  const targetMonth = monthKey(classDate);
  const wKey = computeWeekKey(classDate);

  // Same record and limits as self-booking (bookClass.ts): all of the
  // member's memberships, so a bridge filed under an earlier month that
  // covers this class is found, and a week spanning two months has one
  // weekly limit (weeklyUsedAcrossMemberships).
  const membershipsRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#' },
  }));
  const allMemberships = (membershipsRes.Items ?? []) as MembershipItem[];
  const membership = membershipForClass(allMemberships, classDate, targetMonth, true);

  const walletItem = walletRes.Item as WalletItem | undefined;
  const adminPunchCards = (cardsRes.Items ?? []) as PunchCardItem[];

  let consumedFrom: ConsumedFrom;
  let membershipId = '';
  let adminCardId = '';
  let creditBucket = ''; // wallet batch an EXTRA_PUNCH booking was paid from (refunds go back to it)

  if (membership) {
    const weeklyUsed = weeklyUsedAcrossMemberships(allMemberships, wKey);
    const monthlyUsed = membership.usage?.totalMonthlyUsed ?? 0;
    const withinWeekly = weeklyUsed < membership.weeklyLimit;
    const withinMonthly = monthlyUsed < getEffectiveMonthlyLimit(membership);

    if (withinWeekly && withinMonthly) {
      consumedFrom = 'MEMBERSHIP';
      membershipId = membership.membershipId;
    } else {
      // Soonest-expiring credit still valid on the class date (lib/creditSpend.ts).
      const choice = chooseCredit(walletItem, adminPunchCards, classDate);
      if ('error' in choice) {
        return json(403, choice.error === 'credits_expired'
          ? { error: 'credits_expired', message: CREDITS_EXPIRED_MESSAGE }
          : { error: 'no_credits' });
      }
      consumedFrom = choice.consumedFrom;
      membershipId = membership.membershipId;
      if (choice.consumedFrom === 'ADMIN_CARD') adminCardId = choice.adminCardId;
      else creditBucket = choice.creditBucket;
    }
  } else {
    // No membership: punch cards only, as before.
    const choice = chooseCredit(walletItem, adminPunchCards, classDate, { allowWallet: false });
    if ('error' in choice) {
      return json(403, choice.error === 'credits_expired'
        ? { error: 'credits_expired', message: CREDITS_EXPIRED_MESSAGE }
        : { error: 'membership_required' });
    }
    consumedFrom = choice.consumedFrom;
    if (choice.consumedFrom === 'ADMIN_CARD') adminCardId = choice.adminCardId;
  }

  const newWaitlist = waitlist.filter((e) => e.member !== memberId);
  const nowIso = new Date().toISOString();
  const regKey = { PK: `CLASS#${classId}`, SK: `REG#${memberId}` };

  const regPayload: Record<string, unknown> = {
    PK: regKey.PK,
    SK: regKey.SK,
    GSI1PK: `MEMBER#${memberId}`,
    GSI1SK: `REG#${targetMonth}#${classId}`,
    userId: memberId,
    classId,
    classDate: classItem.date,
    status: 'REGISTERED',
    targetMonth,
    weekKey: wKey,
    consumedFrom,
    membershipId,
    registeredAt: nowIso,
  };
  if (adminCardId) regPayload.adminCardId = adminCardId;
  if (creditBucket) regPayload.creditBucket = creditBucket;

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: regPayload,
        ConditionExpression: 'attribute_not_exists(PK) OR #status <> :registered',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':registered': 'REGISTERED' },
      },
    },
    {
      Update: {
        TableName: TABLE_NAME,
        Key: classKey,
        UpdateExpression: 'ADD currentAttendeesCount :one SET waitlist = :waitlist',
        ConditionExpression: 'currentAttendeesCount < #cap',
        ExpressionAttributeNames: { '#cap': 'capacity' },
        ExpressionAttributeValues: { ':one': 1, ':waitlist': newWaitlist },
      },
    },
  ];

  if (membershipId && consumedFrom === 'MEMBERSHIP' && membership) {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        // The membership's own filing month (a bridge can be filed under an
        // earlier month than the class) — same as bookClass.ts.
        Key: { PK: `MEMBER#${memberId}`, SK: `MEMBERSHIP#${membership.targetMonth}#${membershipId}` },
        // usage is a DynamoDB reserved keyword — bare here it fails every call.
        UpdateExpression: 'ADD #usage.totalMonthlyUsed :one, weeklyUsage.#wk :one SET updatedAt = :now',
        ExpressionAttributeNames: { '#wk': wKey, '#usage': 'usage' },
        ExpressionAttributeValues: { ':one': 1, ':now': nowIso },
      },
    });
  }

  let balanceItemIndex = -1;
  if (consumedFrom === 'EXTRA_PUNCH') {
    balanceItemIndex = transactItems.length;
    // Oldest (soonest-to-expire) credit first — see lib/walletCredit.ts.
    transactItems.push(spendFromBucketItem(memberId, walletItem, creditBucket, nowIso));
  } else if (consumedFrom === 'ADMIN_CARD') {
    balanceItemIndex = transactItems.length;
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${memberId}`, SK: `PUNCHCARD#${adminCardId}` },
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
      if (failed(0)) return json(400, { error: 'doc_missing' });
      if (failed(1)) return json(400, { error: 'class_full' });
      if (balanceItemIndex >= 0 && failed(balanceItemIndex)) {
        return json(400, { error: consumedFrom === 'EXTRA_PUNCH' ? 'wallet_not_found' : 'admin_card_depleted' });
      }
    }
    console.error('[confirmWaitlistSpot] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  return json(200, { success: true, useCredit: consumedFrom !== 'MEMBERSHIP' });
}
