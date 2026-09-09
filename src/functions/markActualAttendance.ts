import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isCoachOrAdmin } from '../lib/auth';

// POST /markActualAttendance
// Body: { classId: string, memberId: string, actualAttendance: 'present' | 'absent' }
// Auth: Cognito JWT, caller must be a coach or admin (isCoachOrAdmin)
//
// This is deliberately the ONLY write action a coach account has anywhere
// in the FORCA Coach feature — every other coach-accessible endpoint
// (getCoachSessions.ts) is read-only. Updates the RegistrationItem
// createTrainingSession.ts auto-created; never touches declaredAttendance
// (that's the trainee's own field, not built yet — see the FORCA Coach plan).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isCoachOrAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; memberId?: unknown; actualAttendance?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const actualAttendance = body.actualAttendance === 'present' || body.actualAttendance === 'absent'
    ? body.actualAttendance : null;
  if (!classId || !memberId || !actualAttendance) return json(400, { error: 'missing_required_fields' });

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: `REG#${memberId}` },
    UpdateExpression: 'SET actualAttendance = :val',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':val': actualAttendance },
  }));

  return json(200, { success: true });
}
