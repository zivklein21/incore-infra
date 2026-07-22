import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { CANCEL_WINDOW_HOURS, MIN_TRAINEES_REQUIRED } from '../lib/cancellationPolicy';

// GET or POST /getCancellationPolicySettings
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
//
// PK='APPCONFIG' SK='CANCELLATION_POLICY' — same "one item per config type
// under a shared PK" convention as getSupportSettings.ts. cancelWindowHours
// and minTraineesRequired default to the same constants
// evaluateCancellationPolicy() actually enforces (lib/cancellationPolicy.ts),
// so this endpoint can't drift from what cancelBooking really does.
// maxCleanCancellationsPerMonth has no enforced default anywhere in the
// codebase yet — returned as null until an admin write path sets it.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: 'APPCONFIG', SK: 'CANCELLATION_POLICY' },
  }));
  const d = res.Item as { cancelWindowHours?: number; minTraineesRequired?: number; maxCleanCancellationsPerMonth?: number } | undefined;

  return json(200, {
    cancelWindowHours: typeof d?.cancelWindowHours === 'number' ? d.cancelWindowHours : CANCEL_WINDOW_HOURS,
    minTraineesRequired: typeof d?.minTraineesRequired === 'number' ? d.minTraineesRequired : MIN_TRAINEES_REQUIRED,
    maxCleanCancellationsPerMonth: typeof d?.maxCleanCancellationsPerMonth === 'number' ? d.maxCleanCancellationsPerMonth : null,
  });
}
