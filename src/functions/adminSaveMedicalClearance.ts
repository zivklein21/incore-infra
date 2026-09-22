import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminSaveMedicalClearance
// Body: { memberId: string, brand?: 'incore' | 'forca', storagePath: string }
// Auth: Cognito JWT, caller must be admin
//
// Admin-authorized counterpart of saveMedicalClearance.ts/
// saveChildMedicalClearance.ts — lets an admin upload/replace a member's
// medical clearance certificate directly (e.g. one collected in person),
// via adminGetS3UploadUrl.ts's 'medical-clearances/' prefix (see
// adminConfig.ts's ADMIN_UPLOAD_PREFIXES). Clears any outstanding request
// flag, same as the self-service/parent-session variants.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; brand?: unknown; storagePath?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  if (!storagePath || !storagePath.startsWith('medical-clearances/')) {
    return json(400, { error: 'invalid_storage_path' });
  }
  const table = tableForBrand(body.brand === 'forca' ? 'forca' : 'incore');

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  forms.medical_clearance_key = storagePath;
  forms.medical_clearance_uploaded_at = new Date().toISOString();
  delete forms.medical_clearance_requested;
  delete forms.medical_clearance_requested_at;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
