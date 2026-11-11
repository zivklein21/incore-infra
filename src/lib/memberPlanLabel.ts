import { BatchGetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from './dynamo';
import type { GroupItem, MembershipItem, ProductItem } from './entities';
import { membershipEndsAt, pickCurrentMembership } from './membershipExpiry';

// The plan/track label member lists show under a member's name ("מנוי חודשי
// 8 כניסות"), and FORCA's group label ("קבוצה: …").
//
// Why this exists: the lists used to read profile.membership.plan, a legacy
// bag nothing has written since the V2 MembershipItem system, so every
// member with a real plan read "No active plan". The plan now comes from the
// member's MEMBERSHIP#/PUNCHCARD# items, resolved in bulk here so a list
// endpoint returns it in the same response (no per-member client calls).

export type PlanMembership = MembershipItem & {
  productId?: string; productName?: string; title?: string; createdAt?: string; isManuallyCreated?: boolean;
};

export type PlanPunchCard = { cardId?: string; remainingPunches?: number; expiryDate?: string | null };

const statusOf = (m: { status?: string }) => (m.status ?? 'ACTIVE').toUpperCase();

/**
 * Whether a membership still counts as the member's plan at `now`: not
 * ended, and ACTIVE (incl. bought for next month), PENDING (new member,
 * future-dated grant) or PAST_DUE (renewal charge still being retried).
 * An ACTIVE one past its end that the hourly sweep hasn't expired yet does
 * not count, nor does EXPIRED/CANCELLED.
 */
export function isCurrentPlan(m: PlanMembership, now: Date): boolean {
  if (!['ACTIVE', 'PENDING', 'PAST_DUE'].includes(statusOf(m))) return false;
  return now.getTime() < membershipEndsAt(m).getTime();
}

/** The membership to label the member with, or null if none is current. */
export function currentPlan(items: PlanMembership[], now: Date): PlanMembership | null {
  return pickCurrentMembership(items.filter((m) => isCurrentPlan(m, now)), now);
}

/** Same name resolution as getMemberMembership's buildMembershipResponse, plus the migration-bridge fallback. */
export function planNameOf(m: PlanMembership, productName: string | undefined): string {
  if (m.type === 'CUSTOM_MIGRATION') return m.productName || m.title || 'מנוי מעבר';
  if (m.isManuallyCreated) return m.productName || productName || '';
  return productName || m.productName || '';
}

export function isUsablePunchCard(c: PlanPunchCard, now: Date): boolean {
  if ((c.remainingPunches ?? 0) <= 0) return false;
  if (!c.expiryDate) return true;
  const exp = new Date(c.expiryDate).getTime();
  return Number.isNaN(exp) || exp > now.getTime();
}

export function punchCardLabel(cards: PlanPunchCard[], now: Date): string {
  const left = cards.filter((c) => isUsablePunchCard(c, now)).reduce((sum, c) => sum + (c.remainingPunches ?? 0), 0);
  return left > 0 ? `כרטיסייה · ${left} כניסות` : '';
}

/** What a member's row shows: the current membership's name, else a usable punch card, else ''. */
export function planLabel(
  memberships: PlanMembership[], punchCards: PlanPunchCard[], productNames: Map<string, string>, now: Date,
): string {
  const m = currentPlan(memberships, now);
  if (m) {
    const name = planNameOf(m, m.productId ? productNames.get(m.productId) : undefined);
    if (name) return name;
  }
  return punchCardLabel(punchCards, now);
}

/**
 * The legacy display-only badge (profile.membership.plan, written only by
 * adminUpdateMemberMembershipBadge.ts) — a fallback for INCORE members with
 * no V2 plan, and only while it isn't marked expired or past its end.
 */
export function legacyPlanLabel(bag: Record<string, unknown> | undefined, now: Date): string {
  if (!bag || typeof bag.plan !== 'string' || !bag.plan) return '';
  if (bag.status === 'expired') return '';
  if (typeof bag.end === 'string' && bag.end) {
    const end = new Date(bag.end).getTime();
    if (!Number.isNaN(end) && end < now.getTime()) return '';
  }
  return bag.plan;
}

/** FORCA trainee/coach/parent row label. */
export function forcaRowLabel(
  p: { role: string; accountType: string; groupId?: string | null; groupIds?: string[] },
  groupNames: Map<string, string>,
): string {
  if (p.accountType === 'parent_only') return 'הורה';
  if (p.role === 'coach') {
    const names = (p.groupIds ?? []).map((id) => groupNames.get(id)).filter(Boolean);
    return names.length ? `מאמן/ת · ${names.join(', ')}` : 'מאמן/ת';
  }
  const name = p.groupId ? groupNames.get(p.groupId) : undefined;
  return name ? `קבוצה: ${name}` : 'ללא קבוצה';
}

// ── Loading ───────────────────────────────────────────────────────────────

export type MemberPlanItems = { memberships: PlanMembership[]; punchCards: PlanPunchCard[] };

function addItem(byMember: Map<string, MemberPlanItems>, item: Record<string, unknown>) {
  const memberId = String(item.PK).replace('MEMBER#', '');
  let entry = byMember.get(memberId);
  if (!entry) { entry = { memberships: [], punchCards: [] }; byMember.set(memberId, entry); }
  if (String(item.SK).startsWith('MEMBERSHIP#')) entry.memberships.push(item as unknown as PlanMembership);
  else entry.punchCards.push(item as PlanPunchCard);
}

/** Every INCORE member's memberships and punch cards in one paginated Scan (same <=50-user tradeoff as getAllMemberProfiles). */
export async function scanAllPlanItems(): Promise<Map<string, MemberPlanItems>> {
  const byMember = new Map<string, MemberPlanItems>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :member) AND (begins_with(SK, :ms) OR begins_with(SK, :pc))',
      ExpressionAttributeValues: { ':member': 'MEMBER#', ':ms': 'MEMBERSHIP#', ':pc': 'PUNCHCARD#' },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items ?? []) addItem(byMember, item);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return byMember;
}

/** The same for a handful of members (a class roster, one member's page): one Query each. */
export async function queryPlanItems(memberIds: string[]): Promise<Map<string, MemberPlanItems>> {
  const byMember = new Map<string, MemberPlanItems>();
  for (const id of memberIds) byMember.set(id, { memberships: [], punchCards: [] });
  await Promise.all(memberIds.flatMap((id) => ['MEMBERSHIP#', 'PUNCHCARD#'].map(async (prefix) => {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `MEMBER#${id}`, ':prefix': prefix },
        ExclusiveStartKey: lastKey,
      }));
      for (const item of res.Items ?? []) addItem(byMember, item);
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  })));
  return byMember;
}

/** Product names for the given productIds, one BatchGet per 100. */
export async function loadProductNames(productIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(Array.from(productIds).filter((id) => id && id !== 'CUSTOM_MIGRATION')));
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + 100).map((id) => ({ PK: `PRODUCT#${id}`, SK: 'METADATA' }));
    while (keys && keys.length) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: keys, ProjectionExpression: 'PK, #n', ExpressionAttributeNames: { '#n': 'name' } } } }));
      for (const p of (res.Responses?.[TABLE_NAME] ?? []) as ProductItem[]) {
        if (p.name) names.set(p.PK.replace('PRODUCT#', ''), p.name);
      }
      keys = res.UnprocessedKeys?.[TABLE_NAME]?.Keys as Record<string, unknown>[] | undefined;
    }
  }
  return names;
}

/** Current productIds across members, for loadProductNames. */
export function currentProductIds(byMember: Map<string, MemberPlanItems>, now: Date): string[] {
  const ids: string[] = [];
  for (const { memberships } of byMember.values()) {
    const m = currentPlan(memberships, now);
    if (m?.productId) ids.push(m.productId);
  }
  return ids;
}

/** Plan label per member id, for the given members' items. */
export async function planLabelsFor(byMember: Map<string, MemberPlanItems>, now: Date = new Date()): Promise<Map<string, string>> {
  const productNames = await loadProductNames(currentProductIds(byMember, now));
  const labels = new Map<string, string>();
  for (const [id, { memberships, punchCards }] of byMember) labels.set(id, planLabel(memberships, punchCards, productNames, now));
  return labels;
}

/** FORCA group names by id, one paginated Scan. */
export async function loadForcaGroupNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    for (const g of (res.Items ?? []) as GroupItem[]) names.set(g.PK.replace('GROUP#', ''), g.name);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return names;
}
