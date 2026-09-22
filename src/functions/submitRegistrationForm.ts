import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

// POST /submitRegistrationForm
// Auth: Cognito JWT (any signed-in member — this is an onboarding-gating
// screen, not admin-only)
// Body: { answers: Record<string, unknown> }
//
// Onboarding-critical: getProfile.ts's requiresRegistrationForm reads these
// same fields, and EntranceScreen.tsx routes here until forms.registration_form
// is true — so this write is what actually unblocks sign-up.
//
// Reads forms first and writes the whole map back (SET forms = :merged)
// rather than a nested `SET forms.registration_form = :true` — DynamoDB
// rejects nested-path updates when the parent map attribute doesn't exist
// yet, which is true for any account that's never had a forms.* field
// written before (adminCreateUser.ts doesn't pre-initialize an empty one).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { answers?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const forms = { ...(profile.forms ?? {}), registration_form: true, registration_answers: answers };

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
