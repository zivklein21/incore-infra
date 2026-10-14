import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey, type MembershipItem } from '../lib/entities';

// DynamoDB caps a transaction at 100 items — 1 Put for the new membership
// leaves 99 for superseding old ones. A member should only ever hold one
// live membership, so hitting this means the data is already broken.
const MAX_SUPERSEDED = 99;

// POST /adminCreateMembershipOverride
// Body: { memberId, planName, productId?, monthlyLimit, weeklyLimit, allowedLegalCancellationsPerMonth?,
//         startDate, endDate, targetMonth?, isAutoRenew? }
// Auth: Cognito JWT, caller must be admin
//
// INCORE-only manual repair for when a purchase went through but
// handlePaymentSuccess didn't create the membership correctly (or at all). Unlike adminGrantMembership /
// adminGrantCustomMigration, this never 409s on an existing membership —
// it supersedes it, same as handlePaymentSuccess (lib/paymentGrants.ts)
// does on a real purchase, but atomically: every ACTIVE/PENDING membership
// flips to EXPIRED (supersededBy = new id) and the new item is Put in one
// TransactWrite, so the member is never left with zero or two live ones.
// PENDING is superseded too — otherwise activatePendingMemberships would
// flip it to ACTIVE later, next to this one.
//
// The plan name is free text. productId is optional — the client sends the
// product from the member's billing agreement (what they actually bought)
// so the membership stays linked to it; no product is ever created here.
//
// The membership item is the exact shape handlePaymentSuccess writes (same
// PK/SK, fields, usage counters). isManuallyCreated/createdByAdmin are
// audit-only extras.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: {
    memberId?: unknown; planName?: unknown; productId?: unknown; monthlyLimit?: unknown; weeklyLimit?: unknown;
    allowedLegalCancellationsPerMonth?: unknown; startDate?: unknown; endDate?: unknown;
    targetMonth?: unknown; isAutoRenew?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const planName = typeof body.planName === 'string' ? body.planName.trim() : '';
  const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
  const startDateStr = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDateStr = typeof body.endDate === 'string' ? body.endDate.trim() : '';
  const monthlyLimit = typeof body.monthlyLimit === 'number' ? Math.floor(body.monthlyLimit) : 0;
  const weeklyLimit = typeof body.weeklyLimit === 'number' ? Math.floor(body.weeklyLimit) : 0;
  const allowedLegal = typeof body.allowedLegalCancellationsPerMonth === 'number'
    ? Math.floor(body.allowedLegalCancellationsPerMonth) : 2;
  const isAutoRenew = typeof body.isAutoRenew === 'boolean' ? body.isAutoRenew : true;

  if (!memberId || !planName || !startDateStr || !endDateStr) {
    return json(400, { error: 'missing_fields', required: ['memberId', 'planName', 'startDate', 'endDate'] });
  }
  if (monthlyLimit <= 0 || weeklyLimit <= 0 || allowedLegal < 0) {
    return json(400, { error: 'invalid_limits', message: 'monthlyLimit and weeklyLimit must be > 0, allowedLegalCancellationsPerMonth >= 0' });
  }
  if (weeklyLimit > monthlyLimit) {
    return json(400, { error: 'invalid_limits', message: 'weeklyLimit cannot exceed monthlyLimit' });
  }

  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return json(400, { error: 'invalid_dates', message: 'startDate and endDate must be valid ISO date strings' });
  }
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);
  if (endDate <= startDate) {
    return json(400, { error: 'invalid_date_range', message: 'endDate must be after startDate' });
  }

  const targetMonth = typeof body.targetMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(body.targetMonth)
    ? body.targetMonth
    : monthKey(startDate);

  const [memberRes, productRes, existingRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } })),
    productId
      ? ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } }))
      : Promise.resolve(null),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#' },
    })),
  ]);
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });
  if (productId && !productRes?.Item) return json(404, { error: 'product_not_found' });
  // Auto-renew charges the saved HYP token — without one there's nothing
  // to renew with (same token adminClearMemberSavedCard removes).
  if (isAutoRenew && !memberRes.Item.payment?.hypToken) {
    return json(400, { error: 'auto_renew_requires_saved_card', message: 'Auto-renew requires a saved card' });
  }

  const toSupersede = ((existingRes.Items ?? []) as MembershipItem[])
    .filter((m) => m.status === 'ACTIVE' || m.status === 'PENDING');
  if (toSupersede.length > MAX_SUPERSEDED) {
    return json(409, { error: 'too_many_live_memberships', count: toSupersede.length });
  }

  // Same rule as adminGrantCustomMigration: a future start must not read as
  // ACTIVE before its window opens — activatePendingMemberships flips it.
  const status = startDate.getTime() > Date.now() ? 'PENDING' : 'ACTIVE';
  const membershipId = randomUUID();
  const nowIso = new Date().toISOString();

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    ...toSupersede.map((old) => ({
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: old.PK, SK: old.SK },
        UpdateExpression: 'SET #status = :expired, supersededBy = :newId, updatedAt = :now',
        // Guard against a concurrent write (renewal, cron) changing it
        // between our read and this transaction — fail rather than clobber.
        ConditionExpression: '#status = :prev',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':expired': 'EXPIRED', ':newId': membershipId, ':now': nowIso, ':prev': old.status },
      },
    })),
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `MEMBER#${memberId}`,
          SK: `MEMBERSHIP#${targetMonth}#${membershipId}`,
          membershipId,
          ...(productId ? { productId } : {}),
          productName: planName,
          status,
          targetMonth,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          isAutoRenew,
          monthlyLimit,
          weeklyLimit,
          allowedLegalCancellationsPerMonth: allowedLegal,
          usage: { totalMonthlyUsed: 0, legalCancellationsUsed: 0, lateCancellationsUsed: 0 },
          weeklyUsage: {},
          isManuallyCreated: true,
          createdByAdmin: adminUid,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      console.warn('[adminCreateMembershipOverride] transaction cancelled', err.CancellationReasons);
      return json(409, { error: 'membership_changed', message: 'The member\'s membership changed while saving — refresh and try again.' });
    }
    throw err;
  }

  console.log(`[adminCreateMembershipOverride] admin=${adminUid} member=${memberId} product=${productId || 'none'} month=${targetMonth} membershipId=${membershipId} status=${status} superseded=${toSupersede.map((m) => m.membershipId).join(',') || 'none'}`);

  return json(201, {
    success: true,
    membershipId,
    targetMonth,
    status,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    isAutoRenew,
    supersededMembershipIds: toSupersede.map((m) => m.membershipId),
  });
}
