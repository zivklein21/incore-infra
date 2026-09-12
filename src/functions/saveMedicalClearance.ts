import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

// POST /saveMedicalClearance
// Body: { storagePath: string }
// Auth: Cognito JWT (any signed-in member — self-service, same as
// submitRegistrationForm.ts). Persists the S3 key of a medical clearance
// certificate the member/her parent just uploaded via getUploadUrl.ts (see
// its 'medical-clearances/' ALLOWED_PREFIXES entry), and clears any
// outstanding admin request for one — same "read forms, write the whole
// map back" idiom as submitRegistrationForm.ts (DynamoDB rejects a nested
// forms.medical_clearance_key update when forms itself doesn't exist yet).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { storagePath?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  if (!storagePath || !storagePath.startsWith('medical-clearances/') || !storagePath.includes(uid)) {
    return json(400, { error: 'invalid_storage_path' });
  }

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  forms.medical_clearance_key = storagePath;
  forms.medical_clearance_uploaded_at = new Date().toISOString();
  delete forms.medical_clearance_requested;
  delete forms.medical_clearance_requested_at;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
