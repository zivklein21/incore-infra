import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { resolveMemberProfile } from '../lib/memberLookup';
import { queryOpenAgreementsForMember } from '../lib/hypAgreementQueries';
import type { ForcaBillingAgreementItem } from '../lib/entities';

// POST /adminClearMemberSavedCard
// Auth: Cognito JWT, caller must be admin
// Body: { memberId: string }
// Clears a member's saved card token and the token on their open billing
// agreement(s), so the recurring charge genuinely has no card to use.
// No brand param — resolves the member's actual table itself (see
// resolveMemberProfile), since it's called from both the INCORE
// AdminPaymentsScreen and FORCA's ForcaSubscriptionAgreementsScreen.
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

  const resolved = await resolveMemberProfile(memberId);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table } = resolved;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    UpdateExpression: 'REMOVE payment.hypToken, payment.hypTokenExpiryMonth, payment.hypTokenExpiryYear, payment.hypTokenProductId, payment.hypTokenUpdatedAt, payment.cardBrand SET payment.hasSavedCard = :false',
    ExpressionAttributeValues: { ':false': false },
  })).catch(async () => {
    // payment map didn't exist at all — nothing to remove, just set hasSavedCard.
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
      UpdateExpression: 'SET payment = :p',
      ExpressionAttributeValues: { ':p': { hasSavedCard: false } },
    }));
  });

  let clearedCount = 0;
  if (table === FORCA_TABLE_NAME) {
    const agreementsRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: '#status IN (:active, :frozen)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'AGREEMENT#', ':active': 'active', ':frozen': 'frozen' },
    }));
    const openAgreements = (agreementsRes.Items ?? []) as ForcaBillingAgreementItem[];
    await Promise.all(openAgreements.map((a) =>
      ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: { PK: a.PK, SK: a.SK },
        // `token` is a DynamoDB reserved keyword — must be aliased.
        UpdateExpression: 'SET #token = :empty, tokenExpiryMonth = :zero, tokenExpiryYear = :zero, updatedAt = :now',
        ExpressionAttributeNames: { '#token': 'token' },
        ExpressionAttributeValues: { ':empty': '', ':zero': 0, ':now': new Date().toISOString() },
      })),
    ));
    clearedCount = openAgreements.length;
  } else {
    const openAgreements = await queryOpenAgreementsForMember(memberId);
    await Promise.all(openAgreements.map((a) =>
      ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: a.PK, SK: a.SK },
        // `token` is a DynamoDB reserved keyword — must be aliased.
        UpdateExpression: 'SET #token = :empty, tokenExpiryMonth = :zero, tokenExpiryYear = :zero, updatedAt = :now',
        ExpressionAttributeNames: { '#token': 'token' },
        ExpressionAttributeValues: { ':empty': '', ':zero': 0, ':now': new Date().toISOString() },
      })),
    ));
    clearedCount = openAgreements.length;
  }

  console.log(`[adminClearMemberSavedCard] member=${memberId} cleared by ${callerUid} (${clearedCount} agreement(s) also cleared)`);
  return json(200, { success: true });
}
