import type { VerifyAuthChallengeResponseTriggerEvent, VerifyAuthChallengeResponseTriggerHandler } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import type { SwitchNonceItem } from '../lib/entities';

// Cognito trigger — see cognitoDefineAuthChallenge.ts for the overall flow.
// Compares the challenge answer switchProfile.ts sent back against the
// privateChallengeParameters.secret cognitoCreateAuthChallenge.ts set. On a
// match, marks the backing SwitchNonceItem consumed so it can never be
// replayed (single-use, independent of its ~60s TTL).
//
// Cognito invokes this directly — no request context carrying which table
// the child's data is in — so this checks both tables in parallel, same as
// cognitoCreateAuthChallenge.ts.
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event: VerifyAuthChallengeResponseTriggerEvent) => {
  const childUid = event.userName;
  const expectedSecret = event.request.privateChallengeParameters.secret;
  const providedSecret = event.request.challengeAnswer;

  event.response.answerCorrect = false;

  if (!expectedSecret || providedSecret !== expectedSecret) return event;

  try {
    const query = (tableName: string) => ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      // consumed is a DynamoDB reserved keyword — see cognitoCreateAuthChallenge.ts.
      FilterExpression: 'secret = :secret AND #consumed = :false',
      ExpressionAttributeNames: { '#consumed': 'consumed' },
      ExpressionAttributeValues: { ':pk': `SWITCHNONCE#${childUid}`, ':prefix': 'NONCE#', ':secret': expectedSecret, ':false': false },
    }));
    const [incoreRes, forcaRes] = await Promise.all([query(TABLE_NAME), query(FORCA_TABLE_NAME)]);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const candidates = [
      ...((incoreRes.Items ?? []) as SwitchNonceItem[]).map((n) => ({ n, table: TABLE_NAME })),
      ...((forcaRes.Items ?? []) as SwitchNonceItem[]).map((n) => ({ n, table: FORCA_TABLE_NAME })),
    ];
    const match = candidates.find(({ n }) => n.expiresAtEpoch > nowEpoch);
    if (!match) return event; // already consumed, expired, or never existed — answerCorrect stays false

    await ddb.send(new UpdateCommand({
      TableName: match.table,
      Key: { PK: match.n.PK, SK: match.n.SK },
      UpdateExpression: 'SET #consumed = :true',
      ConditionExpression: '#consumed = :false',
      ExpressionAttributeNames: { '#consumed': 'consumed' },
      ExpressionAttributeValues: { ':true': true, ':false': false },
    }));

    event.response.answerCorrect = true;
  } catch (err) {
    // Includes ConditionalCheckFailedException from a concurrent double-spend
    // race on the same nonce — fails closed either way.
    console.error('[cognitoVerifyAuthChallengeResponse] verify/consume failed', err);
    event.response.answerCorrect = false;
  }

  return event;
};
