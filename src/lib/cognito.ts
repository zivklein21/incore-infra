import { CognitoIdentityProviderClient, AdminDeleteUserCommand, UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID as string;

// Deletes the corresponding Cognito user when a member profile is deleted.
// user-not-found means they were a legacy account with no Cognito entry —
// not an error, same as the original's auth/user-not-found tolerance.
export async function deleteCognitoUser(uid: string): Promise<void> {
  try {
    await client.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: uid }));
  } catch (err: any) {
    if (!(err instanceof UserNotFoundException)) {
      console.error(`[deleteCognitoUser] Failed to delete Cognito user ${uid}:`, err);
    }
  }
}
