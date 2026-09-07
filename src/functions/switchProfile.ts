import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID, randomBytes } from 'crypto';
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { deriveMemberName, type MemberProfileItem, type FamilyLinkItem, type SwitchNonceItem } from '../lib/entities';

const NONCE_TTL_SECONDS = 60;

// POST /switchProfile
// Auth: Cognito JWT — caller must own an active FamilyLinkItem to childUid.
// Body: { childUid: string }
//
// SECURITY NOTE for whoever reviews this before deploying: this issues real
// Cognito tokens for a DIFFERENT user than the caller, without ever knowing
// that user's password, via a CUSTOM_AUTH challenge round-trip this Lambda
// drives entirely on its own (see cognitoDefineAuthChallenge.ts /
// cognitoCreateAuthChallenge.ts / cognitoVerifyAuthChallengeResponse.ts —
// the three triggers wired in cognito.tf's lambda_config). The single-use,
// 60s-TTL SwitchNonceItem below is the actual secret being verified — the
// family-link ownership check just above it is the ONLY thing standing
// between "any authenticated caller" and "can obtain any other member's
// tokens." Treat any change to that check with the same scrutiny as an
// auth-bypass review.
//
// Returns the raw Cognito AuthenticationResult shape (IdToken/AccessToken/
// RefreshToken/ExpiresIn) rather than the app's CognitoTokens shape — the
// client already has tokensFromAuthResult() (cognitoAuth.ts) to convert
// exactly this shape, so this mirrors what every other Cognito auth response
// already looks like to the client instead of introducing a new one.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const linkRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: `FAMILY#${childUid}` } }));
  const link = linkRes.Item as FamilyLinkItem | undefined;
  if (!link || link.status !== 'active') return json(403, { error: 'forbidden' });

  const childProfileRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${childUid}`, SK: 'PROFILE' } }));
  const childProfile = childProfileRes.Item as MemberProfileItem | undefined;
  if (!childProfile) return json(404, { error: 'child_not_found' });

  const userPoolId = process.env.COGNITO_USER_POOL_ID as string;
  const clientId = process.env.COGNITO_APP_CLIENT_ID as string;
  const cognito = new CognitoIdentityProviderClient({});

  const nonceId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const nowIso = new Date().toISOString();
  const nonceItem: SwitchNonceItem = {
    PK: `SWITCHNONCE#${childUid}`,
    SK: `NONCE#${nonceId}`,
    nonceId,
    parentUid: callerUid,
    childUid,
    secret,
    consumed: false,
    createdAt: nowIso,
    expiresAtEpoch: Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS,
  };
  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: nonceItem }));

  try {
    const initRes = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'CUSTOM_AUTH',
      AuthParameters: { USERNAME: childUid },
    }));
    if (!initRes.Session) throw new Error('No session returned from AdminInitiateAuth');

    const respondRes = await cognito.send(new AdminRespondToAuthChallengeCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      ChallengeName: 'CUSTOM_CHALLENGE',
      Session: initRes.Session,
      ChallengeResponses: { USERNAME: childUid, ANSWER: secret },
    }));

    const auth = respondRes.AuthenticationResult;
    if (!auth?.IdToken || !auth.AccessToken || !auth.RefreshToken || auth.ExpiresIn == null) {
      throw new Error('CUSTOM_AUTH challenge did not issue tokens');
    }

    return json(200, {
      success: true,
      AuthenticationResult: {
        IdToken: auth.IdToken,
        AccessToken: auth.AccessToken,
        RefreshToken: auth.RefreshToken,
        ExpiresIn: auth.ExpiresIn,
      },
      child: { uid: childUid, name: deriveMemberName(childProfile) },
    });
  } catch (err: any) {
    console.error('[switchProfile] CUSTOM_AUTH flow failed', err);
    return json(500, { error: 'switch_failed' });
  }
}
