import { isAdmin } from './auth';
import { resolveMemberProfile } from './memberLookup';

export interface CoachPermissions {
  attendance: 'none' | 'read' | 'write';
  performance: 'none' | 'read';
  healthDeclarations: 'none' | 'read';
  /** Recording/deleting FORCA test attempts (write) vs. only viewing a trainee's attempt history (read) — split off from `performance` since that only ever gated viewing before. */
  testsGrading: 'none' | 'read' | 'write';
  /** The session pack-list check-out/return actions AND managing the global Equipment Pool catalog itself (adminSaveEquipment.ts/adminDeleteEquipment.ts) — split off from `attendance` so a coach can run a session without necessarily managing equipment. No 'read' tier: there's no equipment view separate from the session screen/pool list itself. */
  equipment: 'none' | 'write';
  /** Governs the Exercise Pool catalog (adminSaveExercise.ts, since exercises are a workout plan's building blocks), the Workout Plan Builder itself (adminSaveWorkoutPlan/Block/Exercise.ts), AND assigning an already-built plan to a session (assignSessionWorkoutPlan.ts, 'write' only) — 'read' is view-only access to plans/their assignment. */
  workoutPlans: 'none' | 'read' | 'write';
}

export interface CoachAccess {
  isAdmin: boolean;
  /** 'all' for an admin caller — a coach's own identity.groupIds otherwise, defaulting to [] (deny-by-default) when unset. */
  groupIds: string[] | 'all';
  permissions: CoachPermissions;
}

const ADMIN_PERMISSIONS: CoachPermissions = {
  attendance: 'write', performance: 'read', healthDeclarations: 'read',
  testsGrading: 'write', equipment: 'write', workoutPlans: 'write',
};
const DENIED_PERMISSIONS: CoachPermissions = {
  attendance: 'none', performance: 'none', healthDeclarations: 'none',
  testsGrading: 'none', equipment: 'none', workoutPlans: 'none',
};

// De facto pre-permission-matrix behavior — a coach created/edited without
// ever touching the new permissions UI still works exactly as coaches
// always have (view everything, mark attendance, grade tests, manage
// equipment).
export const DEFAULT_COACH_PERMISSIONS: CoachPermissions = {
  attendance: 'write', performance: 'read', healthDeclarations: 'read',
  testsGrading: 'write', equipment: 'write', workoutPlans: 'read',
};

// Shared body-parsing validator — adminCreateUser.ts and
// adminUpdateCoachPersonal.ts both accept a client-supplied coachPermissions
// object and need the same tolerant-but-safe shape check. Also used by
// getCoachAccess() below to backfill testsGrading/equipment/workoutPlans on
// profiles stored before those fields existed, so a coach who's never
// touched the (now expanded) permissions UI keeps her old effective access
// instead of silently losing it because the new keys read as undefined.
export function parseCoachPermissions(raw: unknown, fallback: Partial<CoachPermissions> = DEFAULT_COACH_PERMISSIONS): CoachPermissions {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const attendance = r.attendance === 'read' || r.attendance === 'write' || r.attendance === 'none'
    ? r.attendance : (fallback.attendance ?? DEFAULT_COACH_PERMISSIONS.attendance);
  const performance = r.performance === 'read' || r.performance === 'none'
    ? r.performance : (fallback.performance ?? DEFAULT_COACH_PERMISSIONS.performance);
  const healthDeclarations = r.healthDeclarations === 'read' || r.healthDeclarations === 'none'
    ? r.healthDeclarations : (fallback.healthDeclarations ?? DEFAULT_COACH_PERMISSIONS.healthDeclarations);
  const testsGrading = r.testsGrading === 'read' || r.testsGrading === 'write' || r.testsGrading === 'none'
    ? r.testsGrading : (fallback.testsGrading ?? DEFAULT_COACH_PERMISSIONS.testsGrading);
  const equipment = r.equipment === 'write' || r.equipment === 'none'
    ? r.equipment : (fallback.equipment ?? DEFAULT_COACH_PERMISSIONS.equipment);
  const workoutPlans = r.workoutPlans === 'read' || r.workoutPlans === 'write' || r.workoutPlans === 'none'
    ? r.workoutPlans : (fallback.workoutPlans ?? DEFAULT_COACH_PERMISSIONS.workoutPlans);
  return { attendance, performance, healthDeclarations, testsGrading, equipment, workoutPlans };
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
  const stored = resolved.profile.identity.coachPermissions;
  return {
    isAdmin: false,
    groupIds: resolved.profile.identity.groupIds ?? [],
    // A coach never configured at all stays deny-by-default; one stored
    // under the pre-expansion 3-field shape gets testsGrading/equipment/
    // workoutPlans backfilled from DEFAULT_COACH_PERMISSIONS (see
    // parseCoachPermissions above) rather than reading as undefined→denied.
    permissions: stored ? parseCoachPermissions(stored, DEFAULT_COACH_PERMISSIONS) : DENIED_PERMISSIONS,
  };
}
