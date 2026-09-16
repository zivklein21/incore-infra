import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

// POST /submitOrthopedicForm
// Auth: Cognito JWT (any signed-in member, or a parent switched into her
// child's session via switchProfile.ts — same as submitRegistrationForm.ts)
// Body: { answers: Record<string, unknown> }
//
// Unlike Registration Form, this is never onboarding-gating — a trainee only
// has one to fill once an admin has flagged forms.orthopedic_form_requested
// via adminSetOrthopedicFormRequested.ts (see MedicalProfileTab.tsx's
// analogous "requested" flag for the same admin-assigns-per-trainee shape).
// Submitting clears that request, same auto-clear idiom saveMedicalClearance.ts
// uses for its own requested flag.
//
// Reads forms first and writes the whole map back (SET forms = :merged)
// rather than a nested-path update — DynamoDB rejects that when the parent
// map attribute doesn't exist yet.
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

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  forms.orthopedic_form = true;
  forms.orthopedic_answers = answers;
  delete forms.orthopedic_form_requested;
  delete forms.orthopedic_form_requested_at;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
