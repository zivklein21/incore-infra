import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { merchOrderHistory } from '../lib/merchOrderHistory';

// GET or POST /getMyOrders
// Auth: Cognito JWT, any signed-in FORCA member — her own merch store
// purchase history, newest first. FORCA-only (the merch store is
// FORCA-exclusive, see createMerchPaymentPage.ts).
//
// createMerchPaymentPage.ts already writes GSI1PK=MEMBER#<uid>,
// GSI1SK=MERCHORDER#<iso>#<orderId> on every order it creates specifically
// so this self-service lookup wouldn't need a table scan.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const result = await merchOrderHistory(FORCA_TABLE_NAME, uid, event.queryStringParameters ?? {});
  if (!result.ok) return json(400, { error: result.error });
  return json(200, result.body);
}
