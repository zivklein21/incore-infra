import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';
import { getMemberFirstLastName, getMemberIdNumber, HYP_NO_ID_PLACEHOLDER, newOrderKey } from '../lib/hypOrders';
import { queryOpenAgreementsForMember } from '../lib/hypAgreementQueries';
import { createHypSignedPaymentUrl, HypSignError } from '../lib/hypClient';

// POST /createHypCardUpdatePage
// Auth: Cognito JWT
// Opens a hosted page for a nominal ₪1 charge whose only purpose is to
// capture a fresh card token; hypPaymentCallback pushes that token onto the
// member's billing agreement(s) and immediately refunds the ₪1. Requires the
// member to already have at least one open (active/paused) billing agreement.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  const member = memberRes.Item as MemberProfileItem | undefined;
  if (!member) return json(404, { error: 'member_not_found' });

  const openAgreements = await queryOpenAgreementsForMember(uid);
  if (openAgreements.length === 0) return json(400, { error: 'no_agreement' });

  const { firstName: clientFirstName, lastName: clientLastName } = getMemberFirstLastName(member);
  const email = member.identity?.email || member.email || '';
  const cell = member.identity?.phone || member.phone || '';

  const { PK, SK, orderId } = newOrderKey();
  const nowIso = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK, SK, orderId,
      userId: uid,
      status: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
      amount: 1,
      productId: 'card_update',
      productName: 'Card Update',
      productType: 'single_ticket',
      paymentMethod: 'one_time',
      totalPayments: 1,
      isCardUpdateOnly: true,
    },
  }));

  try {
    const paymentUrl = await createHypSignedPaymentUrl({
      order: orderId,
      amount: 1,
      tash: 1,
      clientName: clientFirstName || 'Member',
      clientLName: clientLastName || undefined,
      email: email || undefined,
      cell: cell || undefined,
      userId: getMemberIdNumber(member) || HYP_NO_ID_PLACEHOLDER,
      info: 'Card Update',
      pageLang: 'HEB',
    });
    return json(200, { paymentUrl, orderId });
  } catch (err: any) {
    console.error('[createHypCardUpdatePage] HYP SIGN call failed:', err);
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK, SK },
      UpdateExpression: 'SET #status = :failed, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed', ':now': new Date().toISOString() },
    }));
    if (err instanceof HypSignError) {
      return json(502, { error: 'hyp_sign_failed', ccode: err.ccode, hypFields: err.fields });
    }
    return json(502, { error: 'hyp_sign_failed' });
  }
}
