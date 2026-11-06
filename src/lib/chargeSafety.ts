// The check before a recurring charge, for both brands. CHARGE_SAFETY_MODE:
//   report  — log what would be cancelled, then charge exactly as before.
//   enforce — cancel instead of charging.
// Anything but 'enforce' reports, so a missing setting can't cancel anything.

export type ChargeBlockReason = 'member_missing' | 'deletion_pending' | 'no_token' | 'not_active';

export const chargeSafetyEnforced = () => process.env.CHARGE_SAFETY_MODE === 'enforce';

/** Why this charge shouldn't happen; null when it's fine. `members` is everyone it depends on. */
export function chargeBlockReason(
  members: ({ deletionPending?: boolean } | undefined)[], token: string | undefined,
): ChargeBlockReason | null {
  if (members.some((m) => !m)) return 'member_missing';
  if (members.some((m) => m?.deletionPending)) return 'deletion_pending';
  return token ? null : 'no_token';
}

/** Logs the decision; true means the caller must stop and not charge. */
export function applyChargeSafety(brand: 'incore' | 'forca', agreementId: string, userId: string, reason: ChargeBlockReason): boolean {
  const enforced = chargeSafetyEnforced();
  console.warn(`[chargeSafety] ${enforced ? 'CANCELLED' : 'WOULD CANCEL'} brand=${brand} agreement=${agreementId} user=${userId} reason=${reason}`);
  return enforced;
}
