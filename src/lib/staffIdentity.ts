import { resolveMemberProfile } from './memberLookup';
import { deriveMemberName } from './entities';
import type { CoachAccess } from './coachAccess';

export interface StaffIdentity {
  uid: string;
  name: string;
  role: 'admin' | 'coach';
}

// Shared by every endpoint that denormalizes "which staff member wrote
// this" onto a record it writes (markActualAttendance.ts's
// actualAttendanceBy, saveSessionPostWorkoutReport.ts's submittedBy) — same
// resolution, same shape, so the two audit trails read consistently.
export async function resolveStaffIdentity(uid: string, access: CoachAccess): Promise<StaffIdentity> {
  const profile = await resolveMemberProfile(uid);
  return {
    uid,
    name: profile ? deriveMemberName(profile.profile) : uid,
    role: access.isAdmin ? 'admin' : 'coach',
  };
}
