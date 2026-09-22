import type { CreateAuthChallengeTriggerEvent, CreateAuthChallengeTriggerHandler } from 'aws-lambda';
import { randomBytes } from 'crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import type { SwitchNonceItem } from '../lib/entities';

// Cognito trigger — see cognitoDefineAuthChallenge.ts for the overall flow.
// event.userName is the childUid switchProfile.ts requested tokens for.
// Looks up the nonce that same switchProfile.ts invocation just wrote
// (PK=SWITCHNONCE#<childUid>) and hands its secret back as the expected
// challenge answer — never sent to any real client, only ever read back by
// switchProfile.ts's own AdminRespondToAuthChallenge call a few
// milliseconds later in the same request chain.
//
// Cognito invokes this directly — there's no request context carrying which
// table the child's data is in, so (like lib/memberLookup.ts, but querying
// rather than a single GetItem) this checks both in parallel.
export const handler: CreateAuthChallengeTriggerHandler = async (event: CreateAuthChallengeTriggerEvent) => {
  const childUid = event.userName;

  let expectedSecret = randomBytes(32).toString('hex'); // fail-closed default if no valid nonce is found

  try {
    const query = (tableName: string) => ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      // consumed is a DynamoDB reserved keyword — used bare here it fails
      // every single call with ValidationException, same class of bug as
      // bookClass.ts's #cap/#usage aliasing.
      FilterExpression: '#consumed = :false',
      ExpressionAttributeNames: { '#consumed': 'consumed' },
      ExpressionAttributeValues: { ':pk': `SWITCHNONCE#${childUid}`, ':prefix': 'NONCE#', ':false': false },
    }));
    const [incoreRes, forcaRes] = await Promise.all([query(TABLE_NAME), query(FORCA_TABLE_NAME)]);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const candidates = ([...(incoreRes.Items ?? []), ...(forcaRes.Items ?? [])] as SwitchNonceItem[])
      .filter((n) => n.expiresAtEpoch > nowEpoch)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (candidates[0]) expectedSecret = candidates[0].secret;
  } catch (err) {
    console.error('[cognitoCreateAuthChallenge] nonce lookup failed', err);
  }

  event.response.publicChallengeParameters = {};
  event.response.privateChallengeParameters = { secret: expectedSecret };
  event.response.challengeMetadata = 'FAMILY_SWITCH';

  return event;
};
