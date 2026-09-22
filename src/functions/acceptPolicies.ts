import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

function computeAge(birthday: string | number | undefined): number | null {
  if (birthday == null) return null;
  const d = new Date(birthday);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const beforeBirthdayThisYear = now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

// POST /acceptPolicies
// Auth: Cognito JWT (any signed-in member)
// Body (all optional, default false): {
//   medicalInfoConsent?: boolean, healthFormConfirm?: boolean, marketingConsent?: boolean
// }
//
// Onboarding-critical — see submitRegistrationForm.ts for why this reads
// forms first and writes the whole map back rather than a nested SET.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { medicalInfoConsent?: unknown; healthFormConfirm?: unknown; marketingConsent?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  // Photo consent bundled into this same blanket approval — adults only.
  // Under-18 members' photo consent comes from the parent/guardian
  // signature flow (parental_consent.photoConsent, see
  // submitParentalConsent.ts) instead, so it's left untouched here rather
  // than risking a second, conflicting source of truth.
  const birthday = profile.identity?.birthday ?? profile.birthday ?? undefined;
  const age = computeAge(birthday);
  const isAdult = age === null || age >= 18;

  const forms = {
    ...(profile.forms ?? {}),
    agreedToPolicies: true,
    policiesAcceptedAt: new Date().toISOString(),
    policyVersion: '1.0',
    medicalInfoConsent: body.medicalInfoConsent === true,
    healthFormConfirm: body.healthFormConfirm === true,
    marketingConsent: body.marketingConsent === true,
    ...(isAdult ? { photo_consent: true } : {}),
  };

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
