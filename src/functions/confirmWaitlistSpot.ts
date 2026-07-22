import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { ClassItem, MembershipItem, WalletItem, PunchCardItem } from '../lib/entities';
import { monthKey, computeWeekKey } from '../lib/entities';

type ConsumedFrom = 'MEMBERSHIP' | 'EXTRA_PUNCH' | 'ADMIN_CARD';

function findAvailableAdminCard(cards: PunchCardItem[], classDate: Date): PunchCardItem | null {
  return cards.find((c) => {
    if (c.remainingPunches <= 0) return false;
    if (c.expiryDate && new Date(c.expiryDate) < classDate) return false;
    return true;
  }) ?? null;
}

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

  const membershipsRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': `MEMBERSHIP#${targetMonth}#` },
  }));
  const membership = ((membershipsRes.Items ?? []) as MembershipItem[]).find((m) => m.status === 'ACTIVE') ?? null;

  const extraPunches = (walletRes.Item as WalletItem | undefined)?.extraPunches ?? 0;
  const adminPunchCards = (cardsRes.Items ?? []) as PunchCardItem[];

  let consumedFrom: ConsumedFrom;
  let membershipId = '';
  let adminCardId = '';

  if (membership) {
    const weeklyUsed = membership.weeklyUsage?.[wKey] ?? 0;
    const monthlyUsed = membership.usage?.totalMonthlyUsed ?? 0;
    const withinWeekly = weeklyUsed < membership.weeklyLimit;
    const withinMonthly = monthlyUsed < membership.monthlyLimit;

    if (withinWeekly && withinMonthly) {
      consumedFrom = 'MEMBERSHIP';
      membershipId = membership.membershipId;
    } else if (extraPunches > 0) {
      consumedFrom = 'EXTRA_PUNCH';
      membershipId = membership.membershipId;
    } else {
      const card = findAvailableAdminCard(adminPunchCards, classDate);
      if (!card) return json(403, { error: 'no_credits' });
      consumedFrom = 'ADMIN_CARD';
      membershipId = membership.membershipId;
      adminCardId = card.cardId;
    }
  } else {
    const card = findAvailableAdminCard(adminPunchCards, classDate);
    if (!card) return json(403, { error: 'membership_required' });
    consumedFrom = 'ADMIN_CARD';
    adminCardId = card.cardId;
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

  if (membershipId && consumedFrom === 'MEMBERSHIP') {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `MEMBER#${memberId}`, SK: `MEMBERSHIP#${targetMonth}#${membershipId}` },
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
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: walletKey,
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
