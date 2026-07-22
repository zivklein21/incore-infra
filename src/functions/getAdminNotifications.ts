import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET or POST /getAdminNotifications
// Auth: Cognito JWT, caller must be admin
// GSI2PK="ADMINNOTIF" — see notifyAdmins() in lib/adminNotify.ts for the
// write side (dropout alerts etc). No AWS WebSocket transport exists yet,
// so the client polls this instead of the old Firestore onSnapshot
// listener.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    FilterExpression: 'isRead = :false',
    ExpressionAttributeValues: { ':pk': 'ADMINNOTIF', ':false': false },
  }));

  const notifications = ((res.Items ?? []) as Record<string, unknown>[]).map((n) => ({
    id: (n.PK as string).replace('NOTIFICATION#', ''),
    type: n.type,
    priority: n.priority,
    message: n.message,
    createdAt: n.createdAt,
  }));

  return json(200, { notifications });
}
