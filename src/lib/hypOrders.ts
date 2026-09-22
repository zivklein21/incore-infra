import { randomUUID } from 'crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { MemberProfileItem, ProductItem, HypOrderItem, HypProductType, HypPaymentMethod } from './entities';
import { monthKey, endOfMonth } from './entities';
import { queryAllActiveMemberships } from './membershipQueries';

// HYP's `UserId` param doubles as the cardholder's Israeli ID number when the
// terminal is configured to require one (confirmed: our terminal is). Per
// HYP's own docs, "000000000" is the documented placeholder for "customer ID
// unavailable" — the Cognito/DynamoDB uid is NOT a valid fallback (arbitrary
// string, never the cardholder's real ID; sending it risks a CCode 6 decline).
export const HYP_NO_ID_PLACEHOLDER = '000000000';

export function getMemberIdNumber(member: MemberProfileItem): string {
  return member.forms?.health_declaration?.id_number ?? '';
}

// Members are created with separate identity.first_name/last_name — used as
// HYP's separate ClientName/ClientLName SIGN params. Legacy members that
// predate the split only have a combined identity.name; split on the first
// space as a best-effort fallback.
export function getMemberFirstLastName(member: MemberProfileItem): { firstName: string; lastName: string } {
  const identity = member.identity;
  const firstName = identity?.first_name?.trim() ?? '';
  const lastName = identity?.last_name?.trim() ?? '';
  if (firstName || lastName) return { firstName: firstName || 'Member', lastName };

  const combined = identity?.name || member.name || '';
  const parts = combined.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || 'Member', lastName: parts.slice(1).join(' ') };
}

export function getMemberFullName(member: MemberProfileItem): string {
  const { firstName, lastName } = getMemberFirstLastName(member);
  return [firstName, lastName].filter(Boolean).join(' ');
}

export async function getPolicySettings(): Promise<{ standingOrderMonths: number; maxInstallments: number }> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: 'APPCONFIG', SK: 'PAYMENT_POLICY' } }));
  const d = res.Item as { standingOrderMonths?: number; maxInstallments?: number } | undefined;
  return {
    standingOrderMonths: typeof d?.standingOrderMonths === 'number' ? d.standingOrderMonths : 12,
    maxInstallments: typeof d?.maxInstallments === 'number' ? d.maxInstallments : 3,
  };
}

export interface OrderBuild {
  productType: HypProductType;
  productName: string;
  description: string;
  clientFirstName: string;
  clientLastName: string;
  email: string;
  cell: string;
  paymentMethod: HypPaymentMethod;
  firstChargeAmount: number;
  totalPayments: number;
  amountPerCharge?: number;
  totalAmount?: number;
  targetMonth?: string;
  startDate?: string;
  endDate?: string;
  monthlyLimit: number;
  weeklyLimit: number;
  allowedLegalCancellationsPerMonth: number;
  sessions: number;
}

export type OrderBuildError = 'member_not_found' | 'product_not_found' | 'product_inactive' | 'product_not_assigned' | 'invalid_price';

export function orderBuildErrorStatus(error: OrderBuildError): number {
  if (error === 'member_not_found' || error === 'product_not_found') return 404;
  if (error === 'product_not_assigned') return 403;
  return 400;
}

// Shared by createHypPaymentPage (new card, hosted page) and
// createHypTokenPurchase (saved card, direct server-side charge) so the two
// flows can never compute different amounts/dates for the same product.
export async function buildOrderFromProduct(
  uid: string,
  productId: string,
  requestedInstallments?: number,
): Promise<{ ok: true; member: MemberProfileItem; build: OrderBuild } | { ok: false; error: OrderBuildError }> {
  const [memberRes, productRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${productId}`, SK: 'METADATA' } })),
  ]);
  const member = memberRes.Item as MemberProfileItem | undefined;
  const product = productRes.Item as ProductItem | undefined;
  if (!member) return { ok: false, error: 'member_not_found' };
  if (!product) return { ok: false, error: 'product_not_found' };
  if (!product.active) return { ok: false, error: 'product_inactive' };

  // Membership plans have no admin UI to mark them private — treat a missing
  // field as public too, rather than rejecting legacy plans that predate it.
  // Store products (punch_card/single_ticket/mid_month) have a real toggle.
  const isSubscription = product.type === 'subscription';
  const isPublic = isSubscription ? product.is_public !== false : product.is_public === true;
  const assignedTo = product.assigned_to ?? [];

  // Cached so both this gate and the subscription start-date logic below
  // share one query instead of two.
  let activeMembershipsCache: Awaited<ReturnType<typeof queryAllActiveMemberships>> | null = null;
  const getActiveMemberships = async () => {
    if (activeMembershipsCache === null) activeMembershipsCache = await queryAllActiveMemberships(uid);
    return activeMembershipsCache;
  };

  const visibility = product.visibility ?? (isPublic ? 'PUBLIC' : 'PRIVATE');
  let hasAccess: boolean;
  if (visibility === 'PUBLIC') {
    hasAccess = true;
  } else if (visibility === 'GROUPS') {
    // Same "effective group" resolution as the client's canUserAccessProduct:
    // an active membership's product wins; with none, an admin-assigned
    // pending_membership stands in so a not-yet-billed member gets correct
    // access at checkout too, not just in the product list they see.
    const activeMemberships = await getActiveMemberships();
    const activeProductId = (activeMemberships[0] as (typeof activeMemberships[number] & { productId?: string }) | undefined)?.productId ?? null;
    const effectiveGroupProductId = activeProductId || member.pending_membership?.type || null;
    hasAccess = !!effectiveGroupProductId && (product.target_group_ids ?? []).includes(effectiveGroupProductId);
  } else {
    hasAccess = assignedTo.includes(uid);
  }
  if (!hasAccess) return { ok: false, error: 'product_not_assigned' };

  const price = product.price ?? 0;
  if (price <= 0) return { ok: false, error: 'invalid_price' };

  const productType = (product.type ?? 'punch_card') as HypProductType;
  const productName = product.name ?? '';
  const description = product.description ?? '';

  const { firstName: clientFirstName, lastName: clientLastName } = getMemberFirstLastName(member);
  const email = member.identity?.email || member.email || '';
  const cell = member.identity?.phone || member.phone || '';

  const policy = await getPolicySettings();

  // Admin sets the MAX installment count per product; the member picks
  // anywhere from 1 (one-time) up to that max at checkout. mid_month never
  // splits regardless of a stale/leftover field value.
  const maxInstallments = productType !== 'mid_month' && product.installments && product.installments > 1 ? product.installments : 1;
  const installments = maxInstallments > 1 && typeof requestedInstallments === 'number'
    ? Math.min(Math.max(Math.trunc(requestedInstallments), 1), maxInstallments)
    : 1;
  const paymentMethod: HypPaymentMethod = installments > 1 ? 'direct_debit' : 'one_time';

  let firstChargeAmount = price;
  let totalPayments = 1;
  let amountPerCharge: number | undefined;
  let totalAmount: number | undefined;

  if (productType === 'subscription') {
    totalPayments = policy.standingOrderMonths;
    amountPerCharge = price;
  } else if (installments > 1) {
    totalPayments = installments;
    totalAmount = price;
    amountPerCharge = Math.round((price / totalPayments) * 100) / 100;
    firstChargeAmount = Math.round((price - amountPerCharge * (totalPayments - 1)) * 100) / 100;
  }

  let targetMonth: string | undefined;
  let startDate: string | undefined;
  let endDate: string | undefined;

  if (productType === 'subscription') {
    const activeMemberships = await getActiveMemberships();
    // A CUSTOM_MIGRATION bridge shouldn't push a real purchase out to next
    // month — it's a stopgap, not a membership the member is already paying
    // for this month. handlePaymentSuccess supersedes/expires it once this
    // purchase's membership is actually created.
    const hasActiveMembership = activeMemberships.some((m) => m.type !== 'CUSTOM_MIGRATION');

    let start: Date;
    if (hasActiveMembership) {
      start = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1, 0, 0, 0, 0);
    } else {
      start = new Date();
      start.setHours(0, 0, 0, 0);
    }

    const end = endOfMonth(start);
    targetMonth = monthKey(start);
    startDate = start.toISOString();
    endDate = end.toISOString();
  } else if (productType === 'mid_month') {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = endOfMonth(now);
    targetMonth = monthKey(start);
    startDate = start.toISOString();
    endDate = end.toISOString();
  }

  return {
    ok: true,
    member,
    build: {
      productType, productName, description, clientFirstName, clientLastName, email, cell,
      paymentMethod, firstChargeAmount, totalPayments, amountPerCharge, totalAmount,
      targetMonth, startDate, endDate,
      monthlyLimit: product.monthlyLimit && product.monthlyLimit > 0 ? product.monthlyLimit : product.sessions ?? 0,
      weeklyLimit: product.weeklyLimit && product.weeklyLimit > 0 ? product.weeklyLimit : product.sessions_per_week ?? 0,
      allowedLegalCancellationsPerMonth: product.allowedLegalCancellationsPerMonth ?? 2,
      sessions: product.sessions ?? 0,
    },
  };
}

// The "Info" string HYP shows on the hosted page / statement — product name
// alone, or "name - description" when the product has one.
export function buildHypInfo(name: string, description?: string): string {
  return description ? `${name} - ${description}` : name;
}

export function orderFromBuild(orderId: string, uid: string, productId: string, build: OrderBuild): HypOrderItem {
  const nowIso = new Date().toISOString();
  return {
    PK: `ORDER#${orderId}`,
    SK: 'METADATA',
    // adminListHypOrders.ts queries GSI2PK='ORDER' ScanIndexForward:false —
    // without these two, this item is simply absent from GSI2 (DynamoDB
    // GSIs only include items that have the indexed attributes present),
    // so the All Transactions screen silently returned zero rows no matter
    // how many real orders existed in the table.
    GSI2PK: 'ORDER',
    GSI2SK: `${nowIso}#${orderId}`,
    orderId,
    userId: uid,
    status: 'pending',
    createdAt: nowIso,
    updatedAt: nowIso,
    amount: build.firstChargeAmount,
    productId,
    productName: build.productName,
    ...(build.description ? { description: build.description } : {}),
    productType: build.productType,
    paymentMethod: build.paymentMethod,
    totalPayments: build.totalPayments,
    ...(build.amountPerCharge !== undefined ? { amountPerCharge: build.amountPerCharge } : {}),
    ...(build.totalAmount !== undefined ? { totalAmount: build.totalAmount } : {}),
    ...(build.targetMonth ? { targetMonth: build.targetMonth, startDate: build.startDate, endDate: build.endDate } : {}),
    monthlyLimit: build.monthlyLimit,
    weeklyLimit: build.weeklyLimit,
    allowedLegalCancellationsPerMonth: build.allowedLegalCancellationsPerMonth,
    sessions: build.sessions,
  };
}

export function newOrderKey(orderId: string = randomUUID()): { PK: string; SK: string; orderId: string } {
  return { PK: `ORDER#${orderId}`, SK: 'METADATA', orderId };
}
