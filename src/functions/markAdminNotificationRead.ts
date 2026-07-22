import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /markAdminNotificationRead
// Body: { notificationId }
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { notificationId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const notificationId = typeof body.notificationId === 'string' ? body.notificationId.trim() : '';
  if (!notificationId) return json(400, { error: 'missing_notification_id' });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `NOTIFICATION#${notificationId}`, SK: 'METADATA' },
    UpdateExpression: 'SET isRead = :true',
    ExpressionAttributeValues: { ':true': true },
  }));

  return json(200, { success: true });
}
