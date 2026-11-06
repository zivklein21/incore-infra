import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import { getUid, json } from './http';
import type { FamilyLinkItem, ForcaBillingAgreementItem } from './entities';

// Whether anyone this payer pays for still has an active or frozen agreement.
// Agreements are keyed to the trainee, so each linked child is checked.
async function hasOpenAgreementAsPayer(payerUid: string): Promise<boolean> {
  const linksRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${payerUid}`, ':prefix': 'FAMILY#' },
  }));
  const memberIds = [payerUid, ...((linksRes.Items ?? []) as FamilyLinkItem[]).map((l) => l.childUid)];

  const open = await Promise.all(memberIds.map(async (memberId) => {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: '#status IN (:active, :frozen)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'AGREEMENT#', ':active': 'active', ':frozen': 'frozen' },
    }));
    return ((res.Items ?? []) as ForcaBillingAgreementItem[]).some((a) => a.payerUid === payerUid);
  }));
  return open.some(Boolean);
}

// POST /removeMySavedCard
// Auth: Cognito JWT — a FORCA member removing the card on their own profile.
// Each agreement charges its own copy of the token, so removing only the
// profile's card would leave the monthly charge running while the app says
// the card is gone. Refused (409) until no open agreement uses this payer.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  if (await hasOpenAgreementAsPayer(callerUid)) return json(409, { error: 'active_subscription' });

  try {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' },
      ConditionExpression: 'attribute_exists(payment)',
      UpdateExpression: 'REMOVE payment.hypToken, payment.hypTokenExpiryMonth, payment.hypTokenExpiryYear, payment.hypTokenProductId, payment.hypTokenUpdatedAt, payment.cardBrand SET payment.hasSavedCard = :false',
      ExpressionAttributeValues: { ':false': false },
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    return json(404, { error: 'no_saved_card' });
  }

  console.log(`[removeMySavedCard] member=${callerUid} removed own saved card`);
  return json(200, { success: true });
}
