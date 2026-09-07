import type { VerifyAuthChallengeResponseTriggerEvent, VerifyAuthChallengeResponseTriggerHandler } from 'aws-lambda';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { SwitchNonceItem } from '../lib/entities';

// Cognito trigger — see cognitoDefineAuthChallenge.ts for the overall flow.
// Compares the challenge answer switchProfile.ts sent back against the
// privateChallengeParameters.secret cognitoCreateAuthChallenge.ts set. On a
// match, marks the backing SwitchNonceItem consumed so it can never be
// replayed (single-use, independent of its ~60s TTL).
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event: VerifyAuthChallengeResponseTriggerEvent) => {
  const childUid = event.userName;
  const expectedSecret = event.request.privateChallengeParameters.secret;
  const providedSecret = event.request.challengeAnswer;

  event.response.answerCorrect = false;

  if (!expectedSecret || providedSecret !== expectedSecret) return event;

  try {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      // consumed is a DynamoDB reserved keyword — see cognitoCreateAuthChallenge.ts.
      FilterExpression: 'secret = :secret AND #consumed = :false',
      ExpressionAttributeNames: { '#consumed': 'consumed' },
      ExpressionAttributeValues: { ':pk': `SWITCHNONCE#${childUid}`, ':prefix': 'NONCE#', ':secret': expectedSecret, ':false': false },
    }));
    const nowEpoch = Math.floor(Date.now() / 1000);
    const match = ((res.Items ?? []) as SwitchNonceItem[]).find((n) => n.expiresAtEpoch > nowEpoch);
    if (!match) return event; // already consumed, expired, or never existed — answerCorrect stays false

    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: match.PK, SK: match.SK },
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
