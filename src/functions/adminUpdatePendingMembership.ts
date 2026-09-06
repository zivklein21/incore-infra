import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ProductItem } from '../lib/entities';
import { bridgeTokenToBillingAgreement } from '../lib/hypBillingAgreements';

// POST /adminUpdatePendingMembership
// Auth: Cognito JWT, caller must be admin
// Body: { memberId: string, membershipId: string }
// Reassigns the plan a member is pending-assigned to before they've ever
// paid/saved a card (member.pending_membership.type — see adminCreateUser.ts,
// which is the only other place this field is written). Only meaningful
// while no HypBillingAgreementItem exists yet for the member; once one does,
// that agreement (not this field) drives what's actually charged — see
// adminChangeHypBillingAgreementPlan.ts for that case instead.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; membershipId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const membershipId = typeof body.membershipId === 'string' ? body.membershipId.trim() : '';
  if (!memberId || !membershipId) return json(400, { error: 'missing_fields', required: ['memberId', 'membershipId'] });

  const memberKey = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: memberKey }));
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });

  const productRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `PRODUCT#${membershipId}`, SK: 'METADATA' } }));
  const product = productRes.Item as ProductItem | undefined;
  if (!product) return json(404, { error: 'product_not_found' });
  if (product.type !== 'subscription') return json(400, { error: 'product_not_a_subscription' });
  if (product.active === false) return json(400, { error: 'product_inactive' });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: memberKey,
    UpdateExpression: 'SET pending_membership = :pm',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':pm': { type: membershipId } },
  }));

  console.log(`[adminUpdatePendingMembership] member=${memberId} -> pending plan=${membershipId} by ${callerUid}`);

  // If this member already has a usable saved token (from some earlier,
  // unrelated order), this immediately wires it up for 1st-of-month
  // auto-billing instead of leaving it stranded until they manually pay.
  await bridgeTokenToBillingAgreement(memberId);

  return json(200, { success: true, membershipId });
}
