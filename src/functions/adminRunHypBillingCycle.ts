import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { runHypBillingCycle } from '../lib/hypBillingAgreements';

// POST /adminRunHypBillingCycle
// Auth: Cognito JWT, caller must be admin
// Forces a billing cycle run immediately instead of waiting for the nightly
// cron — QA / support retrying a member's charge on demand.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const result = await runHypBillingCycle();
  console.log(`[adminRunHypBillingCycle] triggered by ${callerUid}`);
  return json(200, { success: true, ...result });
}
