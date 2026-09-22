import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { buildProfileResponse } from '../lib/profileResponse';

// GET or POST /getChildProfile?childUid=xxx
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// The FORCA Child Switcher's read path: a parent views her daughter's
// profile from her own session — no ActiveProfileContext.switchToChild, no
// Cognito token swap, her own tabs/permissions never change. Returns the
// exact same shape getProfile.ts does (see buildProfileResponse in
// lib/profileResponse.ts) so ForcaProfileScreen's tab components
// (OverviewTab/FormsStatusTab/etc.) work unmodified against either.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const response = await buildProfileResponse(childUid);
  if (!response) return json(404, { error: 'member_not_found' });

  return json(200, response);
}
