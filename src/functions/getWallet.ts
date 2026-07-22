import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { WalletItem, PunchCardItem } from '../lib/entities';

// GET or POST /getWallet?memberId=xxx
// Auth: Cognito JWT. Defaults to the caller's own wallet; passing a
// different memberId (e.g. for the admin credits/punch-cards screens)
// requires the caller to be admin.
//
// Key is PK=MEMBER#<uid>, SK=WALLET#PRIMARY — see bookClass.ts's key-design
// notes; NOT plain SK=WALLET.
//
// adminPunchCards are stored as separate PunchCardItem entities
// (PK=MEMBER#<uid>, SK=PUNCHCARD#<cardId>, see bookClass.ts) — queried here
// and reshaped to match what the client's wallet reads expect (id instead
// of PunchCardItem's cardId).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const requestedMemberId = event.queryStringParameters?.memberId;
  const memberId = requestedMemberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) {
    return json(403, { error: 'forbidden' });
  }

  const [walletRes, cardsRes] = await Promise.all([
    ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${memberId}`, SK: 'WALLET#PRIMARY' },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'PUNCHCARD#' },
    })),
  ]);

  const wallet = walletRes.Item as WalletItem | undefined;
  const adminPunchCards = ((cardsRes.Items ?? []) as PunchCardItem[]).map((c) => ({
    id: c.cardId,
    remainingPunches: c.remainingPunches,
    expiryDate: c.expiryDate,
    notes: c.notes,
    source: c.source,
  }));

  return json(200, { extraPunches: wallet?.extraPunches ?? 0, adminPunchCards });
}
