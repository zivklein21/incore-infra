import { isAdmin } from './auth';
import { resolveMemberProfile } from './memberLookup';

export interface CoachPermissions {
  attendance: 'none' | 'read' | 'write';
  performance: 'none' | 'read';
  healthDeclarations: 'none' | 'read';
}

export interface CoachAccess {
  isAdmin: boolean;
  /** 'all' for an admin caller — a coach's own identity.groupIds otherwise, defaulting to [] (deny-by-default) when unset. */
  groupIds: string[] | 'all';
  permissions: CoachPermissions;
}

const ADMIN_PERMISSIONS: CoachPermissions = { attendance: 'write', performance: 'read', healthDeclarations: 'read' };
const DENIED_PERMISSIONS: CoachPermissions = { attendance: 'none', performance: 'none', healthDeclarations: 'none' };

// De facto pre-permission-matrix behavior — a coach created/edited without
// ever touching the new permissions UI still works exactly as coaches
// always have (view everything, mark attendance).
export const DEFAULT_COACH_PERMISSIONS: CoachPermissions = { attendance: 'write', performance: 'read', healthDeclarations: 'read' };

// Shared body-parsing validator — adminCreateUser.ts and
// adminUpdateCoachPersonal.ts both accept a client-supplied coachPermissions
// object and need the same tolerant-but-safe shape check.
export function parseCoachPermissions(raw: unknown, fallback: CoachPermissions = DEFAULT_COACH_PERMISSIONS): CoachPermissions {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const attendance = r.attendance === 'read' || r.attendance === 'write' || r.attendance === 'none'
    ? r.attendance : fallback.attendance;
  const performance = r.performance === 'read' || r.performance === 'none'
    ? r.performance : fallback.performance;
  const healthDeclarations = r.healthDeclarations === 'read' || r.healthDeclarations === 'none'
    ? r.healthDeclarations : fallback.healthDeclarations;
  return { attendance, performance, healthDeclarations };
}

export function groupInAccess(access: CoachAccess, groupId: string | undefined): boolean {
  return access.groupIds === 'all' || (!!groupId && access.groupIds.includes(groupId));
}

/**
 * A session is "hers" only when both hold: its group is one she's assigned
 * to, AND she's the session's own coachId — a coach no longer sees/acts on
 * every session in a shared group, only the ones actually assigned to her.
 * Admin is exempt from the coachId half (unrestricted, same as every other
 * admin override in this feature) but still respects groupInAccess (always
 * true for her anyway, since admin's groupIds is 'all').
 */
export function sessionInAccess(access: CoachAccess, session: { groupId?: string; coachId?: string }, callerUid: string): boolean {
  if (!groupInAccess(access, session.groupId)) return false;
  return access.isAdmin || session.coachId === callerUid;
}

// Replaces the old boolean isCoachOrAdmin() at every coach-gated endpoint —
// resolves not just "can this uid touch coach-gated things at all" but
// exactly which groups and which per-action read/write level. An admin
// gets unrestricted access (groupIds: 'all', every permission open); a
// coach gets her own identity.groupIds/coachPermissions, deny-by-default
// (empty groupIds / 'none' permissions) when either was never set — see
// entities.ts's identity.groupIds/coachPermissions comment for why. Returns
// null for a caller who's neither an admin nor a coach at all.
export async function getCoachAccess(uid: string): Promise<CoachAccess | null> {
  if (await isAdmin(uid)) {
    return { isAdmin: true, groupIds: 'all', permissions: ADMIN_PERMISSIONS };
  }
  const resolved = await resolveMemberProfile(uid);
  if (resolved?.profile.identity?.role !== 'coach') return null;
  return {
    isAdmin: false,
    groupIds: resolved.profile.identity.groupIds ?? [],
    permissions: resolved.profile.identity.coachPermissions ?? DENIED_PERMISSIONS,
  };
}
