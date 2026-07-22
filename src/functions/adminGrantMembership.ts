import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey } from '../lib/entities';

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

// POST /adminGrantMembership
// Auth: Cognito JWT, caller must be admin
// See functions/src/adminMembership.ts for the full field/date rationale.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: {
    memberId?: unknown; productId?: unknown; productName?: unknown;
    monthlyLimit?: unknown; weeklyLimit?: unknown;
    allowedLegalCancellationsPerMonth?: unknown; type?: unknown;
    isAutoRenew?: unknown; targetMonth?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
  const productName = typeof body.productName === 'string' ? body.productName.trim() : '';
  const monthlyLimit = typeof body.monthlyLimit === 'number' ? body.monthlyLimit : 0;
  const weeklyLimit = typeof body.weeklyLimit === 'number' ? body.weeklyLimit : 0;
  const allowedLegal = typeof body.allowedLegalCancellationsPerMonth === 'number' ? body.allowedLegalCancellationsPerMonth : 2;
  const subType = body.type === 'mid_month' ? 'mid_month' : 'full';

  if (!memberId || !productId || !productName) {
    return json(400, { error: 'missing_fields', required: ['memberId', 'productId', 'productName'] });
  }
  if (monthlyLimit <= 0 || weeklyLimit <= 0) {
    return json(400, { error: 'invalid_limits', message: 'monthlyLimit and weeklyLimit must be greater than 0' });
  }

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });

  const now = new Date();
  let startDate: Date, endDate: Date, isAutoRenew: boolean;

  if (subType === 'mid_month') {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    endDate = endOfMonth(now);
    isAutoRenew = typeof body.isAutoRenew === 'boolean' ? body.isAutoRenew : false;
  } else {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    endDate = endOfMonth(startDate);
    isAutoRenew = typeof body.isAutoRenew === 'boolean' ? body.isAutoRenew : true;
  }

  const targetMonth = typeof body.targetMonth === 'string' && /^\d{4}-\d{2}$/.test(body.targetMonth)
    ? body.targetMonth
    : monthKey(startDate);

  const existingRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': `MEMBERSHIP#${targetMonth}#` },
  }));
  const existingActive = (existingRes.Items ?? []).find((m) => m.status === 'ACTIVE');
  if (existingActive) {
    return json(409, {
      error: 'membership_already_exists',
      membershipId: existingActive.membershipId,
      message: `An active membership for ${targetMonth} already exists.`,
    });
  }

  const membershipId = randomUUID();
  const nowIso = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `MEMBER#${memberId}`,
      SK: `MEMBERSHIP#${targetMonth}#${membershipId}`,
      membershipId,
      productId,
      productName,
      status: 'ACTIVE',
      targetMonth,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      isAutoRenew,
      monthlyLimit,
      weeklyLimit,
      allowedLegalCancellationsPerMonth: allowedLegal,
      usage: { totalMonthlyUsed: 0, legalCancellationsUsed: 0, lateCancellationsUsed: 0 },
      weeklyUsage: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  }));

  console.log(`[adminGrantMembership] admin=${adminUid} member=${memberId} type=${subType} month=${targetMonth} membershipId=${membershipId}`);

  return json(201, {
    success: true,
    membershipId,
    targetMonth,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    isAutoRenew,
    subType,
  });
}
