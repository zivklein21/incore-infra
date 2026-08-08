import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey } from '../lib/entities';

// POST /adminGrantCustomMigration
// Auth: Cognito JWT, caller must be admin
// See functions/src/adminMembership.ts for the full field rationale — used
// for manually onboarding trainees mid-cycle from the old system.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: {
    memberId?: unknown; title?: unknown; startDate?: unknown; endDate?: unknown;
    totalMonthlyLimit?: unknown; weeklyLimit?: unknown; allowedLegalCancellations?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const startDateStr = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDateStr = typeof body.endDate === 'string' ? body.endDate.trim() : '';
  const totalMonthlyLimit = typeof body.totalMonthlyLimit === 'number' ? body.totalMonthlyLimit : 0;
  const weeklyLimit = typeof body.weeklyLimit === 'number' ? body.weeklyLimit : 0;
  const allowedLegalCancellations = typeof body.allowedLegalCancellations === 'number' ? body.allowedLegalCancellations : 0;

  if (!memberId || !title || !startDateStr || !endDateStr) {
    return json(400, { error: 'missing_fields', required: ['memberId', 'title', 'startDate', 'endDate'] });
  }
  if (totalMonthlyLimit <= 0 || weeklyLimit <= 0 || allowedLegalCancellations <= 0) {
    return json(400, { error: 'invalid_limits', message: 'totalMonthlyLimit, weeklyLimit, and allowedLegalCancellations must be greater than 0' });
  }

  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return json(400, { error: 'invalid_dates', message: 'startDate and endDate must be valid ISO date strings' });
  }
  if (endDate <= startDate) {
    return json(400, { error: 'invalid_date_range', message: 'endDate must be after startDate' });
  }

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });

  const targetMonth = monthKey(startDate);

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

  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  // A future startDate means this membership isn't usable yet — it must not
  // read as ACTIVE (which would make it eligible for booking/rollover
  // before its window opens). activatePendingMemberships flips it to ACTIVE
  // once startDate arrives.
  const status = startDate.getTime() > Date.now() ? 'PENDING' : 'ACTIVE';

  const membershipId = randomUUID();
  const nowIso = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `MEMBER#${memberId}`,
      SK: `MEMBERSHIP#${targetMonth}#${membershipId}`,
      membershipId,
      type: 'CUSTOM_MIGRATION',
      status,
      title,
      isManuallyCreated: true,
      requiresPayment: false,
      productId: 'CUSTOM_MIGRATION',
      productName: title,
      targetMonth,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      isAutoRenew: false,
      monthlyLimit: totalMonthlyLimit,
      weeklyLimit,
      allowedLegalCancellationsPerMonth: allowedLegalCancellations,
      usage: { totalMonthlyUsed: 0, legalCancellationsUsed: 0, lateCancellationsUsed: 0 },
      weeklyUsage: {},
      createdAt: nowIso,
      updatedAt: nowIso,
      createdByAdmin: adminUid,
    },
  }));

  console.log(`[adminGrantCustomMigration] admin=${adminUid} member=${memberId} month=${targetMonth} membershipId=${membershipId} status=${status}`);

  return json(201, {
    success: true,
    membershipId,
    targetMonth,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    status,
    type: 'CUSTOM_MIGRATION',
  });
}
