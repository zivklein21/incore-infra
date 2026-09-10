import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { RegistrationItem } from '../lib/entities';

// POST /declareAttendance
// Body: { classId: string, declaredAttendance: 'yes' | 'no', declineReason?: string }
// Auth: Cognito JWT, any signed-in member — but only for her own registration
// (the REG#<callerUid> item under CLASS#<classId> must exist; there's no
// admin/coach override here, that's markActualAttendance.ts's job instead).
// FORCA-only. declineReason is only stored when declaredAttendance is 'no'.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { classId?: unknown; declaredAttendance?: unknown; declineReason?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });
  const declaredAttendance = body.declaredAttendance === 'yes' || body.declaredAttendance === 'no' ? body.declaredAttendance : null;
  if (!declaredAttendance) return json(400, { error: 'invalid_declared_attendance' });
  const declineReason = declaredAttendance === 'no' && typeof body.declineReason === 'string' ? body.declineReason.trim() : '';

  const key = { PK: `CLASS#${classId}`, SK: `REG#${callerUid}` };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const registration = res.Item as RegistrationItem | undefined;
  if (!registration) return json(404, { error: 'registration_not_found' });

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET declaredAttendance = :declaredAttendance, declineReason = :declineReason',
    ExpressionAttributeValues: { ':declaredAttendance': declaredAttendance, ':declineReason': declineReason },
  }));

  return json(200, { success: true });
}
