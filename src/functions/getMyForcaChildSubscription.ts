import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ForcaBillingAgreementItem, MemberProfileItem } from '../lib/entities';

// GET or POST /getMyForcaChildSubscription?childUid=<uid>
// Auth: Cognito JWT — a parent reading a linked daughter's subscription
// (family-link-verified, same Child Switcher convention as
// getChildOrders.ts), or omit childUid to read the caller's own (a
// self-signed-in trainee gets read-only visibility into her own
// subscription, same as every other Profile tab — she just can't act on it,
// per the FORCA billing spec's parent-only purchasing rule).
//
// No AWS WebSocket transport exists yet — fetched once + polled by the
// client, same interim pattern as getMyBillingAgreement.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const q = event.queryStringParameters ?? {};
  const childUid = typeof q.childUid === 'string' ? q.childUid.trim() : '';

  let targetUid = callerUid;
  if (childUid) {
    const link = await verifyFamilyLink(callerUid, childUid);
    if (!link.ok) return json(403, { error: 'forbidden' });
    targetUid = childUid;
  }

  const [agreementRes, profileRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${targetUid}`, ':prefix': 'AGREEMENT#' },
    })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${targetUid}`, SK: 'PROFILE' } })),
  ]);

  const agreements = (agreementRes.Items ?? []) as ForcaBillingAgreementItem[];
  const agreement = agreements.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const membership = (profileRes.Item as MemberProfileItem | undefined)?.membership as { end?: string } | undefined;

  if (!agreement) return json(200, { hasAgreement: false, membershipEnd: membership?.end ?? null });

  const hasToken = !!agreement.token;
  const declined = hasToken && agreement.lastChargeResult?.success === false;

  return json(200, {
    hasAgreement: true,
    agreementId: agreement.agreementId,
    status: agreement.status,
    amountPerCharge: agreement.amountPerCharge,
    productName: agreement.productName,
    groupName: agreement.groupName,
    nextChargeDate: agreement.nextChargeDate ?? null,
    hasToken,
    declined,
    membershipEnd: membership?.end ?? null,
  });
}
