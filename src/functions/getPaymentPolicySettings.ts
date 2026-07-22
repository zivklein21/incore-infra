import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { getPolicySettings } from '../lib/hypOrders';

// GET or POST /getPaymentPolicySettings
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
//
// Reuses getPolicySettings() from lib/hypOrders.ts — the same PK=APPCONFIG,
// SK=PAYMENT_POLICY item and defaults (standingOrderMonths=12,
// maxInstallments=3) already used server-side to build HYP standing orders.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const { standingOrderMonths, maxInstallments } = await getPolicySettings();

  return json(200, { standingOrderMonths, maxInstallments });
}
