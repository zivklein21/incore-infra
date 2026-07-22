import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { HypBillingAgreementItem } from '../lib/entities';

// GET or POST /getMyBillingAgreement
// Auth: Cognito JWT (any signed-in member, own agreement only)
//
// Replaces ProfileScreen's old onSnapshot listener on hyp_billing_agreements
// (userId==uid, kind=='subscription', status in ['active','failed']). No
// AWS WebSocket transport exists yet, so this is fetched once + polled by
// the client instead of pushed — same interim pattern as getWallet.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    FilterExpression: '#status IN (:active, :failed)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pk': `MEMBER#${uid}`,
      ':prefix': 'AGREEMENT#subscription#',
      ':active': 'active',
      ':failed': 'failed',
    },
  }));

  const agreement = (res.Items ?? [])[0] as HypBillingAgreementItem | undefined;
  if (!agreement) return json(200, { hasAgreement: false });

  const hasToken = !!agreement.token;
  const declined = hasToken && agreement.lastChargeResult?.success === false;

  return json(200, {
    hasAgreement: true,
    amountPerCharge: agreement.amountPerCharge,
    productName: agreement.productName,
    nextChargeDate: agreement.nextChargeDate ?? null,
    hasToken,
    declined,
  });
}
