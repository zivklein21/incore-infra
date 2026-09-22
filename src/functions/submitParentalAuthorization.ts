import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

// POST /submitParentalAuthorization
// Auth: Cognito JWT (any signed-in member — this is an onboarding-gating
// screen, not admin-only; a FORCA parent reaches it switched into her
// trainee via ActiveProfileContext.switchToChild, same as
// submitRegistrationForm.ts/submitHealthDeclaration.ts, so the write always
// lands on the trainee's own profile even though the parent is the one
// physically signing).
// Body: { parentName, parentPhone, parentEmail, signaturePaths: string[], signatureKey? }
//
// Onboarding-critical: getProfile.ts's requiresParentalAuthorization reads
// this same field, and resolvePostLoginRoute.ts routes here until
// forms.parental_authorization.submitted_at is set — so this write is part
// of what unblocks a FORCA trainee's own first login.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { parentName?: unknown; parentPhone?: unknown; parentEmail?: unknown; signaturePaths?: unknown; signatureKey?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const parentName = typeof body.parentName === 'string' ? body.parentName.trim() : '';
  const parentPhone = typeof body.parentPhone === 'string' ? body.parentPhone.trim() : '';
  const parentEmail = typeof body.parentEmail === 'string' ? body.parentEmail.trim() : '';
  const signaturePaths = Array.isArray(body.signaturePaths) ? body.signaturePaths.filter((p): p is string => typeof p === 'string') : [];
  const signatureKey = typeof body.signatureKey === 'string' ? body.signatureKey : undefined;

  if (!parentName || !parentPhone || !parentEmail || signaturePaths.length === 0) {
    return json(400, { error: 'missing_fields' });
  }

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const forms = {
    ...(profile.forms ?? {}),
    parental_authorization: {
      submitted_at: new Date().toISOString(),
      parentName,
      parentPhone,
      parentEmail,
      signaturePaths,
      ...(signatureKey ? { signatureKey } : {}),
    },
  };

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
