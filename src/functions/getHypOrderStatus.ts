import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypOrderItem } from '../lib/entities';

// GET or POST /getHypOrderStatus?orderId=xxx
// Auth: Cognito JWT. Caller must own the order or be admin.
//
// Backup path for StoreScreen/SubscriptionPlanSelectScreen — HYP's redirect
// back into the app's WebView is flaky across devices, so the client polls
// this instead of the old Firestore onSnapshot listener on the order doc to
// catch a charge that completed server-side even if the redirect never
// fires.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const orderId = event.queryStringParameters?.orderId;
  if (!orderId) return json(400, { error: 'missing_order_id' });

  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `ORDER#${orderId}`, SK: 'METADATA' } }));
  const order = res.Item as HypOrderItem | undefined;
  if (!order) return json(404, { error: 'order_not_found' });
  if (order.userId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  return json(200, { status: order.status });
}
