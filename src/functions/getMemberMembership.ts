import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MembershipItem, ProductItem } from '../lib/entities';
import { pickCurrentMembership } from '../lib/membershipExpiry';


type FullMembershipItem = MembershipItem & {
  productId?: string; productName?: string; startDate?: string; endDate?: string; createdAt?: string;
  isManuallyCreated?: boolean;
};

// The membership covering today first — a member who bought next month
// early holds two ACTIVE ones, and the current month's is the one to show;
// then one still to come; then PENDING > PAST_DUE > CANCELLED > EXPIRED as
// before (lib/membershipExpiry.ts pickCurrentMembership).
export function pickActive(items: FullMembershipItem[], now: Date = new Date()): FullMembershipItem | null {
  return pickCurrentMembership(items, now);
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

  // An admin repair (adminCreateMembershipOverride.ts) carries its own name
  // and limits on purpose — the limits are what bookClass enforces, so show
  // those rather than the linked product's defaults. It may have no
  // productId at all, so it still has to read as a subscription.
  const limitsSource = item.isManuallyCreated ? undefined : productData;
  const productName = item.isManuallyCreated
    ? (item.productName || productData?.name || '')
    : (productData?.name ?? item.productName ?? '');

  return {
    membershipId: item.membershipId,
    productId: item.productId ?? '',
    productName,
    productType: item.type === 'CUSTOM_MIGRATION' ? 'CUSTOM_MIGRATION'
      : (productData?.type ?? (item.isManuallyCreated ? 'subscription' : '')),
    price: productData?.price ?? 0,
    status: item.status ?? 'ACTIVE',
    monthlyUsed: item.usage?.totalMonthlyUsed ?? 0,
    legalCancellationsUsed: item.usage?.legalCancellationsUsed ?? 0,
    lateCancellationsUsed: item.usage?.lateCancellationsUsed ?? 0,
    monthlyLimit: limitsSource?.monthlyLimit ?? item.monthlyLimit ?? 0,
    manualAdjustment: item.manualAdjustment ?? 0,
    weeklyLimit: limitsSource?.weeklyLimit ?? item.weeklyLimit ?? 0,
    allowedLegalCancellationsPerMonth: limitsSource?.allowedLegalCancellationsPerMonth ?? item.allowedLegalCancellationsPerMonth ?? 0,
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
