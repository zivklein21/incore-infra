import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypBillingAgreementItem, MemberProfileItem } from '../lib/entities';

// GET/POST /adminListHypBillingAgreements
// Auth: Cognito JWT, caller must be admin
// Returns every billing agreement with the member's name resolved, newest first.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  // Paginated (not a flat Limit) — GSI2PK='AGREEMENT' holds every agreement
  // ever created (any kind/status), so a hard cap here could silently drop
  // an old-but-still-legitimately-active subscription off the admin's list
  // once total history grows past it, even though the nightly charge cron
  // (which reads GSI3, unrelated to this cap) keeps billing it correctly.
  const items: HypBillingAgreementItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'AGREEMENT' },
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []) as HypBillingAgreementItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const agreements = await Promise.all(items.map(async (a) => {
    const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${a.userId}`, SK: 'PROFILE' } }));
    const member = memberRes.Item as MemberProfileItem | undefined;
    const memberName = member?.identity?.name || member?.name || 'Unknown';

    return {
      id: a.agreementId,
      memberId: a.userId,
      memberName,
      kind: a.kind,
      productId: a.productId,
      productName: a.productName,
      status: a.status,
      hasToken: !!a.token,
      amountPerCharge: a.amountPerCharge,
      totalAmount: a.totalAmount ?? null,
      paymentsCompleted: a.paymentsCompleted,
      totalPayments: a.totalPayments,
      consecutiveFailures: a.consecutiveFailures,
      nextChargeDate: a.nextChargeDate ?? null,
      lastChargeResult: a.lastChargeResult ?? null,
    };
  }));

  return json(200, { agreements });
}
