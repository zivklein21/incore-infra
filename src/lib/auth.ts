import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { resolveMemberProfile } from './memberLookup';
import type { MemberProfileItem } from './entities';

// API Gateway's JWT authorizer already confirms the caller is a valid,
// authenticated member (see getUid in http.ts) — this only answers whether
// that member additionally has the admin role, same check the original
// Firebase functions did by reading their member profile document.
//
// Deliberately checks TABLE_NAME (incore) only, not FORCA_TABLE_NAME too —
// admins aren't brand-scoped members. There's one shared set of human
// admins who toggle the Backoffice between managing either brand's data
// (see AdminBrandModeContext); their own account lives in the incore table
// regardless of which brand they're currently viewing.
export async function isAdmin(uid: string): Promise<boolean> {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
  }));
  const item = res.Item as MemberProfileItem | undefined;
  return item?.role === 'admin' || item?.identity?.role === 'admin';
}

// Coach (מדריכה) is a FORCA-only, restricted staff role — view-only across
// training sessions/rosters/tracking, with exactly one write action
// (markActualAttendance.ts). Unlike isAdmin(), this can't assume the incore
// table: a coach's account is created in whichever table brand:'forca'
// resolves to, so this goes through resolveMemberProfile()'s dual-table
// lookup instead of a direct Get. An admin already passes isAdmin() so is
// included here too — every coach-gated endpoint an admin can also use.
export async function isCoachOrAdmin(uid: string): Promise<boolean> {
  if (await isAdmin(uid)) return true;
  const resolved = await resolveMemberProfile(uid);
  return resolved?.profile.identity?.role === 'coach';
}
