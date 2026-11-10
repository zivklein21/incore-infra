import { deriveMemberName } from './entities';
import { resolveMemberProfile } from './memberLookup';

// Audit trail for every manual (admin) create/edit of an INCORE
// MembershipItem: who, when, and each changed field's value before → after.
// Stored on the item itself in manualLog[] (the admin Subscriptions screen
// lists it; the app version in the stores reads at/by/action/changes/reason
// and ignores `diff`/`source`). Changes made outside the app — the DynamoDB
// console, the CLI — can't be recorded here.

export interface ManualLogEntry {
  at: string;
  by: { uid: string; name: string };
  action: 'created' | 'duplicated' | 'edited' | 'cancelled';
  /** The admin endpoint that wrote it, e.g. 'adminSaveMemberSubscription'. */
  source?: string;
  /** Field names that changed, for 'edited'. */
  changes?: string[];
  /** Each audited field: its value before → after (from: null on create). */
  diff?: Record<string, { from: unknown; to: unknown }>;
  /** The subscription this one was copied from, for 'duplicated'. */
  fromMembershipId?: string;
  /** For an edit that moved it to another month (its key changes with it). */
  fromMonth?: string;
  toMonth?: string;
  reason?: string;
}

/** The fields an audit entry records. */
export const AUDITED_FIELDS = [
  'status', 'type', 'title', 'productId', 'productName', 'targetMonth', 'startDate', 'endDate', 'isAutoRenew',
  'monthlyLimit', 'weeklyLimit', 'allowedLegalCancellationsPerMonth', 'totalAmount', 'paymentOrderId', 'supersededBy',
] as const;

const norm = (v: unknown) => (v === undefined ? null : v);

/** before → after for every audited field that differs (both sides normalized: undefined → null). */
export function diffFields(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of AUDITED_FIELDS) {
    if (!(k in after)) continue;
    const from = norm(before?.[k]);
    const to = norm(after[k]);
    if (JSON.stringify(from) !== JSON.stringify(to)) out[k] = { from, to };
  }
  return out;
}

export function auditEntry(
  by: { uid: string; name: string },
  action: ManualLogEntry['action'],
  source: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  extra: Partial<ManualLogEntry> = {},
  at: string = new Date().toISOString(),
): ManualLogEntry {
  const diff = diffFields(before, after);
  return {
    at, by, action, source,
    ...(action === 'edited' ? { changes: Object.keys(diff) } : {}),
    diff,
    ...extra,
  };
}

export async function adminIdentity(uid: string): Promise<{ uid: string; name: string }> {
  const resolved = await resolveMemberProfile(uid);
  return { uid, name: resolved ? deriveMemberName(resolved.profile) : uid };
}
