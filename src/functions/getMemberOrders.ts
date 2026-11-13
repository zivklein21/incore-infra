import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { merchOrderHistory } from '../lib/merchOrderHistory';

// GET or POST /getMemberOrders?memberId=xxx&brand=incore|forca
// Auth: Cognito JWT, caller must be admin
//
// Admin-authorized counterpart of getMyOrders.ts/getChildOrders.ts — powers
// the Backoffice Trainee Profile's Purchase History tab (see the Backoffice
// Trainee Profile unification plan). Refunding an order still goes through
// the existing adminRefundMerchOrder.ts, unchanged.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const memberId = event.queryStringParameters?.memberId;
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;

  const result = await merchOrderHistory(tableForBrand(brand), memberId, event.queryStringParameters ?? {});
  if (!result.ok) return json(400, { error: result.error });
  return json(200, result.body);
}
