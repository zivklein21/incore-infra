import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminSetUserPasswordCommand,
  InvalidPasswordException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminResetMemberPassword
// Auth: Cognito JWT, caller must be admin
// Body: { memberId: string, newPassword: string }
//
// SECURITY NOTE (same tradeoff as adminCreateUser.ts / adminClearMemberSavedCard.ts):
// AdminSetUserPassword is an IAM-privileged Cognito action shared across this
// repo's single Lambda execution role — the isAdmin(uid) check below is the
// only gate.
//
// Sets the password directly and Permanent: true, which puts the user in
// CONFIRMED status with no FORCE_CHANGE_PASSWORD challenge — the member can
// sign in with it immediately and is never prompted to change it (unlike
// adminCreateUser's TemporaryPassword flow).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; newPassword?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!memberId || !newPassword) return json(400, { error: 'missing_fields', required: ['memberId', 'newPassword'] });

  const userPoolId = process.env.COGNITO_USER_POOL_ID as string;
  const cognito = new CognitoIdentityProviderClient({});

  try {
    // Username accepts the Cognito sub (== our uid/memberId) same as
    // deleteCognitoUser — the pool's username_attributes=["email"] makes
    // both the sub and the email alias resolve to the same user.
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: memberId,
      Password: newPassword,
      Permanent: true,
    }));
  } catch (err: any) {
    if (err instanceof UserNotFoundException) return json(404, { error: 'member_not_found' });
    if (err instanceof InvalidPasswordException) return json(400, { error: 'invalid_password', message: err.message });
    console.error('[adminResetMemberPassword] Cognito error', err);
    return json(500, { error: 'cognito_error' });
  }

  console.log(`[adminResetMemberPassword] member=${memberId} password reset by ${callerUid}`);
  return json(200, { success: true });
}
