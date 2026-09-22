import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';

// POST /saveChildMedicalClearance
// Body: { childUid: string, storagePath: string }
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of saveMedicalClearance.ts
// — persists the S3 key of a medical clearance certificate the parent just
// uploaded on her daughter's behalf via getChildUploadUrl.ts. See the FORCA
// Child Switcher plan.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { childUid?: unknown; storagePath?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  if (!storagePath || !storagePath.startsWith('medical-clearances/') || !storagePath.includes(childUid)) {
    return json(400, { error: 'invalid_storage_path' });
  }

  const resolved = await resolveMemberProfile(childUid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  forms.medical_clearance_key = storagePath;
  forms.medical_clearance_uploaded_at = new Date().toISOString();
  delete forms.medical_clearance_requested;
  delete forms.medical_clearance_requested_at;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${childUid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
