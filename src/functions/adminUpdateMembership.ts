import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminUpdateMembership
// Body: { memberId, membershipId, targetMonth, monthlyLimit?, weeklyLimit?,
//         productId?, productName?, allowedLegalCancellationsPerMonth?, endDate?,
//         manualAdjustment? }
// Auth: Cognito JWT, caller must be admin
//
// Partial update of an existing membership's plan/limits — used by
// MemberDetailsScreen's "edit weekly/monthly limit" and "repair
// membership" (re-point at a different product) actions. Does not touch
// usage/weeklyUsage counters.
//
// `endDate` is only meaningful for CUSTOM_MIGRATION memberships — that's
// the one type monthEndRollover.ts actually reads it for (see
// hypBillingAgreements-adjacent rollover logic); on a regular subscription
// it's just that month's billing-window boundary and gets replaced every
// renewal, so the frontend only ever sends this for CUSTOM_MIGRATION items.
// Accepted generically here like the other optional fields, with no
// server-side type check, matching this endpoint's existing trust model.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    memberId?: unknown; membershipId?: unknown; targetMonth?: unknown;
    monthlyLimit?: unknown; weeklyLimit?: unknown; productId?: unknown;
    productName?: unknown; allowedLegalCancellationsPerMonth?: unknown;
    endDate?: unknown; manualAdjustment?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const membershipId = typeof body.membershipId === 'string' ? body.membershipId.trim() : '';
  const targetMonth = typeof body.targetMonth === 'string' ? body.targetMonth.trim() : '';
  if (!memberId || !membershipId || !targetMonth) {
    return json(400, { error: 'missing_fields', required: ['memberId', 'membershipId', 'targetMonth'] });
  }

  const fields: Record<string, unknown> = {};
  if (typeof body.monthlyLimit === 'number') fields.monthlyLimit = body.monthlyLimit;
  if (typeof body.weeklyLimit === 'number') fields.weeklyLimit = body.weeklyLimit;
  if (typeof body.productId === 'string') fields.productId = body.productId;
  if (typeof body.productName === 'string') fields.productName = body.productName;
  if (typeof body.allowedLegalCancellationsPerMonth === 'number') fields.allowedLegalCancellationsPerMonth = body.allowedLegalCancellationsPerMonth;
  if (typeof body.endDate === 'string' && !isNaN(new Date(body.endDate).getTime())) fields.endDate = body.endDate;
  if (typeof body.manualAdjustment === 'number') fields.manualAdjustment = body.manualAdjustment;
  if (Object.keys(fields).length === 0) return json(400, { error: 'no_fields_to_update' });

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = Object.entries(fields).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: `MEMBERSHIP#${targetMonth}#${membershipId}` },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  return json(200, { success: true });
}
