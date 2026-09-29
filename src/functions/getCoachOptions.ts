import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { getAllMemberProfiles } from '../lib/memberScan';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import { deriveMemberName } from '../lib/entities';

// GET or POST /getCoachOptions
// Auth: Cognito JWT, caller must be admin
//
// Merges FORCA-table coaches with INCORE-table admins into one picker list
// for assigning a Training Session — a coach and an admin live in different
// tables (see isAdmin()'s/isCoachOrAdmin()'s comments), so there's no single
// existing lookup that already returns both together. Used by
// createTrainingSession.ts's admin/coach picker (coachId/coachName are
// denormalized onto the ClassItem at creation, not resolved by id later).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const [incoreProfiles, forcaProfiles] = await Promise.all([
    getAllMemberProfiles(),
    getAllMemberProfiles(FORCA_TABLE_NAME),
  ]);

  const admins = incoreProfiles
    .filter((p) => p.role === 'admin' || p.identity?.role === 'admin')
    // The Backoffice admin is always Or Saraf — her own INCORE profile row
    // isn't guaranteed to carry a real display name the way a FORCA
    // member's does, so this is shown directly rather than trusting
    // deriveMemberName() to resolve it correctly.
    .map((p) => ({ id: (p.PK as string).replace('MEMBER#', ''), name: 'Or Saraf', isAdmin: true }));

  const coaches = forcaProfiles
    .filter((p) => p.identity?.role === 'coach')
    .map((p) => ({ id: (p.PK as string).replace('MEMBER#', ''), name: deriveMemberName(p), isAdmin: false }));

  const options = [...coaches, ...admins].sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { options });
}
