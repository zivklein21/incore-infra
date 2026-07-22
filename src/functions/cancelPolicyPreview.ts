import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, RegistrationItem } from '../lib/entities';
import { evaluateCancellationPolicy, CANCEL_WINDOW_HOURS, MIN_TRAINEES_REQUIRED } from '../lib/cancellationPolicy';

// POST /cancelPolicyPreview
// Body: { classId: string }
// Auth: Cognito JWT
//
// Returns the same policy evaluation as cancelBooking WITHOUT cancelling —
// the client uses this to show an accurate preview before the user confirms.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const [regRes, classRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: `REG#${uid}` } })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
  ]);

  const regData = regRes.Item as RegistrationItem | undefined;
  if (!regData) return json(400, { error: 'not_booked' });
  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  const policy = await evaluateCancellationPolicy(uid, regData, classItem);

  return json(200, {
    isLegal: policy.isLegal,
    policy: {
      hoursUntilClass: Math.round(policy.hoursUntilClass * 10) / 10,
      cancelWindowHours: CANCEL_WINDOW_HOURS,
      remainingAfterCancel: policy.remainingAfterCancel,
      minTraineesRequired: MIN_TRAINEES_REQUIRED,
      isTimeOk: policy.isTimeOk,
      isOccupancyOk: policy.isOccupancyOk,
      isQuotaOk: policy.isQuotaOk,
      allowedLegalCancellationsPerMonth: policy.allowedLegalCancellationsPerMonth,
      lateReason: policy.lateReason,
    },
  });
}
