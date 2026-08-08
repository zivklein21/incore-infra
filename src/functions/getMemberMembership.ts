import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MembershipItem, ProductItem } from '../lib/entities';

// PENDING ranks above the lapsed statuses — a member with a future-dated
// grant queued up and an old CANCELLED/EXPIRED record from a prior month
// should see the pending one, not the stale one, when only one can be shown.
const STATUS_PRIORITY: Record<string, number> = { ACTIVE: 0, PENDING: 1, PAST_DUE: 2, CANCELLED: 3, EXPIRED: 4 };

type FullMembershipItem = MembershipItem & {
  productId?: string; productName?: string; startDate?: string; endDate?: string; createdAt?: string;
};

export function pickActive(items: FullMembershipItem[]): FullMembershipItem | null {
  if (items.length === 0) return null;
  return [...items].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status ?? 'ACTIVE'] ?? 99;
    const pb = STATUS_PRIORITY[b.status ?? 'ACTIVE'] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  })[0];
}

export async function buildMembershipResponse(item: FullMembershipItem) {
  let productData: ProductItem | undefined;
  // CUSTOM_MIGRATION is a sentinel productId (admin-created bridge
  // membership, not a real PRODUCT# record) — skip the lookup, it would
  // always miss and silently leave productType as '', which made the
  // client's hasActiveSubscription/renewal-disclosure checks treat these
  // members as having no subscription at all.
  if (item.productId && item.productId !== 'CUSTOM_MIGRATION') {
    const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${item.productId}`, SK: 'METADATA' } }));
    productData = res.Item as ProductItem | undefined;
  }

  return {
    membershipId: item.membershipId,
    productId: item.productId ?? '',
    productName: productData?.name ?? item.productName ?? '',
    productType: item.type === 'CUSTOM_MIGRATION' ? 'CUSTOM_MIGRATION' : (productData?.type ?? ''),
    price: productData?.price ?? 0,
    status: item.status ?? 'ACTIVE',
    monthlyUsed: item.usage?.totalMonthlyUsed ?? 0,
    legalCancellationsUsed: item.usage?.legalCancellationsUsed ?? 0,
    lateCancellationsUsed: item.usage?.lateCancellationsUsed ?? 0,
    monthlyLimit: productData?.monthlyLimit ?? item.monthlyLimit ?? 0,
    weeklyLimit: productData?.weeklyLimit ?? item.weeklyLimit ?? 0,
    allowedLegalCancellationsPerMonth: productData?.allowedLegalCancellationsPerMonth ?? item.allowedLegalCancellationsPerMonth ?? 0,
    isAutoRenew: item.isAutoRenew === true,
    startDate: item.startDate ?? null,
    endDate: item.endDate ?? null,
  };
}

// GET or POST /getMemberMembership?memberId=xxx
// Auth: Cognito JWT. Defaults to the caller's own; a different memberId
// requires admin.
//
// Returns the "best" membership (any status, not just ACTIVE — a
// PAST_DUE/EXPIRED one still needs to be shown with its real status, not
// hidden) — priority ACTIVE > PAST_DUE > CANCELLED > EXPIRED, tiebroken by
// most-recently-created. Distinct from getActiveMembership.ts, which is
// ACTIVE-only and feeds booking-quota UI decisions.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const memberId = event.queryStringParameters?.memberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#' },
  }));

  const target = pickActive((res.Items ?? []) as FullMembershipItem[]);
  if (!target) return json(200, null);

  return json(200, await buildMembershipResponse(target));
}
