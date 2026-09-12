import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminSetMedicalClearanceRequested
// Body: { memberId: string, requested: boolean, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, caller must be admin
//
// Flags a member's Medical Profile tab as needing a fresh clearance
// certificate (surfaced as a banner there — see MedicalProfileTab.tsx). The
// upload control itself is always available to the member regardless of
// this flag; saveMedicalClearance.ts clears it automatically once she
// uploads. brand-aware (tableForBrand) — same fix getMemberDetail.ts needed,
// since FORCA members live in a fully separate table.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; requested?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const requested = body.requested === true;
  const table = tableForBrand(body.brand === 'forca' ? 'forca' : 'incore');

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  if (requested) {
    forms.medical_clearance_requested = true;
    forms.medical_clearance_requested_at = new Date().toISOString();
  } else {
    delete forms.medical_clearance_requested;
    delete forms.medical_clearance_requested_at;
  }

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
