import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deleteMemberData } from '../lib/memberDeletion';

// POST /adminDeleteMember
// Body: { memberId, brand? }
// Auth: Cognito JWT, caller must be admin
//
// Stops all charging, deletes the member's app data and archives what must be
// kept. Returns the charging check. See lib/memberDeletion.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  try {
    const result = await deleteMemberData(memberId, body.brand === 'forca' ? 'forca' : 'incore', callerUid);
    if (!result.found) return json(404, { error: 'member_not_found' });
    return json(200, { success: true, verification: result.verification });
  } catch (err) {
    // Every step can run again, so the admin finishes this by deleting again.
    console.error(`[adminDeleteMember] member=${memberId} left pending`, err);
    return json(502, { error: 'deletion_pending' });
  }
}
