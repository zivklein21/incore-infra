import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { buildProfileResponse } from '../lib/profileResponse';

// GET or POST /getProfile?memberId=xxx
// Auth: Cognito JWT. Defaults to the caller's own profile; passing a
// different memberId requires the caller to be admin (same pattern as
// getWallet.ts). A parent reading her linked child's profile without an
// identity switch goes through getChildProfile.ts instead (verifyFamilyLink
// authorization, not isAdmin) — see the FORCA Child Switcher plan.
//
// requiresRegistrationForm / requiresHealthDeclaration / requiresPoliciesAgreement
// are computed by computeComplianceFlags() (lib/entities.ts) from forms.*
// (see submitRegistrationForm.ts / submitHealthDeclaration.ts /
// acceptPolicies.ts, which write those fields) and admin.require_health_form
// / admin.require_registration_form (set at account-creation time by
// adminCreateUser.ts) — same logic the old Firebase useAuth.ts's
// buildAuthUser used. Also reused by listMyFamily.ts so a FORCA parent can
// see which linked daughter still needs forms.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const requestedMemberId = event.queryStringParameters?.memberId;
  const memberId = requestedMemberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) {
    return json(403, { error: 'forbidden' });
  }

  const response = await buildProfileResponse(memberId);
  if (!response) return json(404, { error: 'member_not_found' });

  return json(200, response);
}
