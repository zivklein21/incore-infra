import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MerchOrderItem } from '../lib/entities';

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

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'MERCHORDER#' },
    ScanIndexForward: false,
  }));
  const items = (res.Items ?? []) as MerchOrderItem[];

  const orders = items.map((o) => ({
    id: o.orderId,
    status: o.status,
    amount: o.amount,
    items: o.items.map((li) => ({
      productName: li.merchProductName,
      variantLabel: li.merchVariantLabel,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
    })),
    createdAt: o.createdAt,
    refundedAmount: o.refundedAmount ?? null,
    refundedAt: o.refundedAt ?? null,
  }));

  return json(200, { orders });
}
