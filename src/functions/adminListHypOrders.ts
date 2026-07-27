import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypOrderItem, MemberProfileItem } from '../lib/entities';

// GET/POST /adminListHypOrders
// Auth: Cognito JWT, caller must be admin
// Most recent HYP payment orders (any status), newest first.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': 'ORDER' },
    ScanIndexForward: false,
    Limit: 100,
  }));
  const items = (res.Items ?? []) as HypOrderItem[];

  const orders = await Promise.all(items.map(async (o) => {
    const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${o.userId}`, SK: 'PROFILE' } }));
    const member = memberRes.Item as MemberProfileItem | undefined;
    const memberName = member?.identity?.name || member?.name || 'Unknown';

    return {
      id: o.orderId,
      memberId: o.userId,
      memberName,
      productName: o.productName,
      productType: o.productType,
      paymentMethod: o.paymentMethod,
      amount: o.amount,
      status: o.status,
      hypCCode: o.hypCCode ?? null,
      createdAt: o.createdAt ?? null,
      // Present whenever this order is one of several payments (either a
      // HYP-native Tash installment sale charged in one shot, or a single
      // charge out of a subscription/store_installment billing agreement) —
      // lets the admin UI show a breakdown instead of a bare amount that
      // reads like a one-off purchase. See entities.ts HypOrderItem.
      totalPayments: o.totalPayments ?? null,
      amountPerCharge: o.amountPerCharge ?? null,
      totalAmount: o.totalAmount ?? null,
      installmentsCount: o.installmentsCount ?? null,
      installmentAmount: o.installmentAmount ?? null,
    };
  }));

  return json(200, { orders });
}
