import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MerchOrderItem } from '../lib/entities';

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

  const res = await ddb.send(new QueryCommand({
    TableName: tableForBrand(brand),
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MERCHORDER#' },
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
