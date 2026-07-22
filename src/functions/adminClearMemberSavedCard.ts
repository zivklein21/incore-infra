import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { queryOpenAgreementsForMember } from '../lib/hypAgreementQueries';

// POST /adminClearMemberSavedCard
// Auth: Cognito JWT, caller must be admin
// Body: { memberId: string }
// Clears a member's saved card token and the token on their open billing
// agreement(s), so the recurring charge genuinely has no card to use.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_fields', required: ['memberId'] });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    UpdateExpression: 'REMOVE payment.hypToken, payment.hypTokenExpiryMonth, payment.hypTokenExpiryYear, payment.hypTokenProductId, payment.hypTokenUpdatedAt, payment.cardBrand SET payment.hasSavedCard = :false',
    ExpressionAttributeValues: { ':false': false },
  })).catch(async () => {
    // payment map didn't exist at all — nothing to remove, just set hasSavedCard.
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
      UpdateExpression: 'SET payment = :p',
      ExpressionAttributeValues: { ':p': { hasSavedCard: false } },
    }));
  });

  const openAgreements = await queryOpenAgreementsForMember(memberId);
  await Promise.all(openAgreements.map((a) =>
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: a.PK, SK: a.SK },
      UpdateExpression: 'SET token = :empty, tokenExpiryMonth = :zero, tokenExpiryYear = :zero, updatedAt = :now',
      ExpressionAttributeValues: { ':empty': '', ':zero': 0, ':now': new Date().toISOString() },
    })),
  ));

  console.log(`[adminClearMemberSavedCard] member=${memberId} cleared by ${callerUid} (${openAgreements.length} agreement(s) also cleared)`);
  return json(200, { success: true });
}
