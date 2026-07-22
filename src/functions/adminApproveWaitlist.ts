import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, QueryCommand, PutCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey, computeWeekKey, type ClassItem, type MembershipItem } from '../lib/entities';

// POST /adminApproveWaitlist
// Body: { classId, userId, skipLimitCheck?: boolean }
// Auth: Cognito JWT, caller must be admin
//
// Force-moves a waiting/pending waitlist entry straight to REGISTERED,
// mirroring the member self-serve confirmWaitlistSpot.ts flow but
// admin-initiated (no expiry window) and with an optional weekly-limit
// override for cases the admin has already cleared with the member.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; userId?: unknown; skipLimitCheck?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const skipLimitCheck = body.skipLimitCheck === true;
  if (!classId || !userId) return json(400, { error: 'missing_fields', required: ['classId', 'userId'] });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey }));
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  const entry = (classItem.waitlist ?? []).find((e) => e.member === userId);
  if (!entry) return json(400, { error: 'not_on_waitlist' });

  const classDate = new Date(classItem.date);
  const targetMonth = monthKey(classDate);
  const wKey = computeWeekKey(classDate);

  const membRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `MEMBER#${userId}`, ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE' },
  }));
  const activeMembership = (membRes.Items ?? [])[0] as MembershipItem | undefined;

  if (!skipLimitCheck && activeMembership) {
    const weeklyLimit = activeMembership.weeklyLimit ?? 0;
    const bookedThisWeek = activeMembership.weeklyUsage?.[wKey] ?? 0;
    if (weeklyLimit > 0 && bookedThisWeek >= weeklyLimit) {
      return json(200, { limitExceeded: true, bookedThisWeek, sessionsPerWeek: weeklyLimit });
    }
  }

  const remainingWaitlist = (classItem.waitlist ?? []).filter((e) => e.member !== userId);
  const nowIso = new Date().toISOString();
  const regKey = { PK: `CLASS#${classId}`, SK: `REG#${userId}` };

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Update: {
        TableName: TABLE_NAME,
        Key: classKey,
        UpdateExpression: 'SET waitlist = :waitlist ADD currentAttendeesCount :one',
        ExpressionAttributeValues: { ':waitlist': remainingWaitlist, ':one': 1 },
      },
    },
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
          consumedFrom: 'MEMBERSHIP',
          membershipId: activeMembership?.membershipId ?? '',
          registeredAt: nowIso,
        },
      },
    },
  ];

  if (activeMembership) {
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
    if (err instanceof TransactionCanceledException) return json(400, { error: 'transaction_failed' });
    console.error('[adminApproveWaitlist] transaction failed', err);
    return json(500, { error: 'transaction_failed' });
  }

  const dateStr = classDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Jerusalem' });
  const timeStr = classDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' });
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${userId}`,
        SK: `MESSAGE#${randomUUID()}`,
        type: 'update',
        title: 'Spot Confirmed!',
        body: `You've been added to ${classItem.className ?? ''} on ${dateStr} at ${timeStr}. See you there!`,
        classId,
        className: classItem.className ?? '',
        classDate: classItem.date,
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        requiresAction: false,
        read: false,
      },
    }));
  } catch (err) {
    console.error('[adminApproveWaitlist] message failed', err);
  }

  return json(200, { success: true });
}
