import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import { sendEmail, maskEmailForLog } from '../lib/mailer';
import { buildCognitoEmail, emailKindForTrigger, pickBrand } from '../lib/cognitoEmail';

// Cognito Custom Email Sender trigger (cognito.tf lambda_config). Cognito
// hands us every email it would otherwise send itself (password-reset codes
// from the app's ForgotPassword, verification codes, AdminCreateUser
// invitations). We send them through lib/mailer.ts, so they come from
// no-reply@incoretraining.com with the member's own brand ("INCORE" or
// "FORCA"). Cognito's built-in email_configuration can only have one From
// name for the whole pool, and both apps share this pool.
//
// The code arrives encrypted with our KMS key (COGNITO_EMAIL_KMS_KEY_ARN);
// only this function's role may decrypt it. The code is never logged.
//
// A throw makes Cognito fail the ForgotPassword call, so the member sees the
// app's generic error and can retry. That is the right outcome: a reset that
// "succeeds" without an email is worse.

const KEY_ARN = process.env.COGNITO_EMAIL_KMS_KEY_ARN ?? '';

interface CustomEmailSenderEvent {
  triggerSource: string;
  userName?: string;
  request: {
    code?: string | null;
    userAttributes?: Record<string, string>;
  };
}

let decryptFn: ((ciphertext: Buffer) => Promise<Buffer>) | null = null;

function getDecrypt(): (ciphertext: Buffer) => Promise<Buffer> {
  if (decryptFn) return decryptFn;
  // Bundled into this function by scripts/build.mjs (vendor/cognito-crypto).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildClient, CommitmentPolicy, KmsKeyringNode } = require('@aws-crypto/client-node') as typeof import('@aws-crypto/client-node');
  const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
  const keyring = new KmsKeyringNode({ keyIds: [KEY_ARN] });
  decryptFn = async (ciphertext) => (await decrypt(keyring, ciphertext)).plaintext;
  return decryptFn;
}

async function existsIn(tableName: string, email: string): Promise<boolean> {
  const res = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'GSI3PK = :pk',
    ExpressionAttributeValues: { ':pk': `EMAIL#${email}` },
    Limit: 1,
  }));
  return (res.Items ?? []).length > 0;
}

export async function handler(event: CustomEmailSenderEvent): Promise<void> {
  const kind = emailKindForTrigger(event.triggerSource);
  const email = (event.request.userAttributes?.email ?? '').toLowerCase().trim();
  if (!kind) {
    console.log(`[cognitoCustomEmailSender] ${event.triggerSource}: nothing to send`);
    return;
  }
  if (!email || !event.request.code) {
    throw new Error(`[cognitoCustomEmailSender] ${event.triggerSource}: missing email or code`);
  }
  if (!KEY_ARN) throw new Error('[cognitoCustomEmailSender] COGNITO_EMAIL_KMS_KEY_ARN is not set');

  const [code, brand] = await Promise.all([
    getDecrypt()(Buffer.from(event.request.code, 'base64')).then((b) => b.toString('utf8')),
    // A lookup failure must not block a reset code: send it as INCORE.
    Promise.all([existsIn(TABLE_NAME, email), existsIn(FORCA_TABLE_NAME, email)])
      .then(([i, f]) => pickBrand(i, f))
      .catch((err) => {
        console.warn(`[cognitoCustomEmailSender] brand lookup failed (${err?.name ?? 'Error'}), using INCORE`);
        return pickBrand(false, false);
      }),
  ]);

  const content = buildCognitoEmail(kind, brand, code);
  await sendEmail({ to: email, ...content }, `cognito:${event.triggerSource.replace('CustomEmailSender_', '')}`);
  console.log(`[cognitoCustomEmailSender] ${kind} brand=${brand} to=${maskEmailForLog(email)}`);
}
