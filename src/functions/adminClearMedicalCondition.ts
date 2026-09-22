import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import { resolveStaffIdentity } from '../lib/staffIdentity';
import { resolveMemberProfile } from '../lib/memberLookup';

// POST /adminClearMedicalCondition
// Body: { memberId: string }
// Auth: Cognito JWT, caller must be admin or a coach with attendance:'write'
// — there's no dedicated "medical" permission axis in coachAccess.ts yet,
// and attendance:'write' is the existing axis for a coach's real-time,
// session-day operational trust, which this matches best (reuse, not a new
// axis, to keep the permissions matrix from growing for a single action).
//
// A trainee flags forms.medical_condition_changed via
// reportMedicalConditionChange.ts, which blocks her own declareAttendance.ts
// 'yes' path — this is the only way to lift that block, after a human has
// actually reviewed her note (returned by getProfile's medicalConditionNote).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || (!access.isAdmin && access.permissions.attendance !== 'write')) {
    return json(403, { error: 'forbidden' });
  }

  let body: { memberId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const resolved = await resolveMemberProfile(memberId);
  if (!resolved) return json(404, { error: 'member_not_found' });
  const { table, profile } = resolved;

  const clearedBy = await resolveStaffIdentity(callerUid, access);

  const forms = { ...(profile.forms ?? {}) } as Record<string, unknown>;
  forms.medical_condition_changed = false;
  forms.medical_condition_cleared_at = new Date().toISOString();
  forms.medical_condition_cleared_by = clearedBy;

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
