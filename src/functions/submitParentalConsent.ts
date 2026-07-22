import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';

// POST /submitParentalConsent
// Auth: Cognito JWT (any signed-in member)
// Body: { parentName, parentPhone, parentEmail, signaturePaths, photoConsent, signatureKey? }
//
// signatureKey is an S3 object key (see getUploadUrl.ts), optional since
// upload itself is best-effort in the client. Consent is valid for 2 years
// from signing, matching the original Firestore version's expiresAt.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: {
    parentName?: unknown; parentPhone?: unknown; parentEmail?: unknown;
    signaturePaths?: unknown; photoConsent?: unknown; signatureKey?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const parentName = typeof body.parentName === 'string' ? body.parentName : '';
  const parentPhone = typeof body.parentPhone === 'string' ? body.parentPhone : '';
  const parentEmail = typeof body.parentEmail === 'string' ? body.parentEmail : '';
  const signaturePaths = Array.isArray(body.signaturePaths) ? body.signaturePaths : [];
  const photoConsent = body.photoConsent === true;
  if (!parentName || !parentPhone || !parentEmail || signaturePaths.length === 0) {
    return json(400, { error: 'missing_fields', required: ['parentName', 'parentPhone', 'parentEmail', 'signaturePaths'] });
  }

  const key = { PK: `MEMBER#${uid}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const now = new Date();
  const expires = new Date(now);
  expires.setFullYear(expires.getFullYear() + 2);

  const parentalConsent: Record<string, unknown> = {
    isApproved: true,
    parentName,
    parentPhone,
    parentEmail,
    signaturePaths,
    photoConsent,
    signedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  if (typeof body.signatureKey === 'string' && body.signatureKey) {
    parentalConsent.signatureKey = body.signatureKey;
  }

  const forms = { ...(profile.forms ?? {}), parental_consent: parentalConsent };

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
