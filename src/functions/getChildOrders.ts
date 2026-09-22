import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { MerchOrderItem } from '../lib/entities';

// GET or POST /getChildOrders?childUid=xxx
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of getMyOrders.ts — lets a
// parent review/manage her daughter's merch purchase history from her own
// account. See the FORCA Child Switcher plan.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: link.table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'MERCHORDER#' },
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
