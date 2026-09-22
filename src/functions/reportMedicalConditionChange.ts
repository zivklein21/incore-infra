import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';

// POST /reportMedicalConditionChange
// Body: { note: string }
// Auth: Cognito JWT, any signed-in member (self-service, same as
// saveMedicalClearance.ts). A trainee flags that something about her
// medical condition has changed since her last clearance — this locks
// declareAttendance.ts's 'yes' path (see its medical_condition_changed
// check) until an admin/coach reviews the note and clears it via
// adminClearMedicalCondition.ts. FORCA-only in practice (only the FORCA
// Trainee Dashboard calls this), but not brand-gated here since the write
// itself is harmless for an INCORE member (nothing reads this flag outside
// FORCA's attendance flow).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { note?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) return json(400, { error: 'missing_note' });

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  forms.medical_condition_changed = true;
  forms.medical_condition_changed_at = new Date().toISOString();
  forms.medical_condition_note = note;
  delete forms.medical_condition_cleared_at;
  delete forms.medical_condition_cleared_by;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
