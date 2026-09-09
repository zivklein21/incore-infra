import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { createFamilyLink } from '../lib/familyLinks';

// POST /adminLinkFamilyMember
// Auth: Cognito JWT, caller must be admin
// Body: { parentUid: string, childUid: string }
//
// v1 is a simple one-parent-per-child tree (no multi-parent/co-parent
// support, no self-service member-initiated linking) — see the Family
// Accounts plan. Relaxing "one parent per child" later only means dropping
// the GSI1 check in lib/familyLinks.ts — the schema already supports it
// (GSI1 on the child side naturally returns every parent).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { parentUid?: unknown; childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const parentUid = typeof body.parentUid === 'string' ? body.parentUid.trim() : '';
  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!parentUid || !childUid) return json(400, { error: 'missing_required_fields' });
  if (parentUid === childUid) return json(400, { error: 'cannot_link_self' });

  const result = await createFamilyLink(parentUid, childUid, callerUid);
  if (!result.ok) {
    const status = result.error === 'parent_not_found' || result.error === 'child_not_found' ? 404
      : result.error === 'already_linked' ? 409
      : 400; // child_already_linked, brand_mismatch
    return json(status, { error: result.error });
  }

  return json(200, { success: true, linkId: result.linkId });
}
