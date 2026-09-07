import type { DefineAuthChallengeTriggerEvent, DefineAuthChallengeTriggerHandler } from 'aws-lambda';

// Cognito trigger — invoked directly by the User Pool (see cognito.tf's
// lambda_config), NOT via API Gateway. Only ever engaged when a client
// requests AuthFlow: CUSTOM_AUTH (switchProfile.ts is the only caller in
// this codebase) — the pool's existing USER_PASSWORD_AUTH sign-in path every
// member already uses does not invoke this trigger at all.
//
// This pool issues exactly one custom challenge ("FAMILY_SWITCH") per
// CUSTOM_AUTH attempt: first call has no session history, so ask for it;
// once cognitoVerifyAuthChallengeResponse.ts has judged an answer, honor
// that verdict.
export const handler: DefineAuthChallengeTriggerHandler = async (event: DefineAuthChallengeTriggerEvent) => {
  const session = event.request.session ?? [];
  const last = session[session.length - 1];

  if (session.length === 0) {
    event.response.challengeName = 'CUSTOM_CHALLENGE';
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    return event;
  }

  if (last?.challengeName === 'CUSTOM_CHALLENGE' && last.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  }

  return event;
};
