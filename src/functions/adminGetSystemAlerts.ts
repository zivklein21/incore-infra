import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { SystemAlertItem } from '../lib/entities';

// GET /adminGetSystemAlerts?limit=50
// Auth: Cognito JWT, caller must be admin
// Newest-first feed of items written by recordSystemAlert() (lib/alerts.ts)
// — GSI1PK='ALERT' holds every alert regardless of severity/source.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const limitParam = Number(event.queryStringParameters?.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'ALERT' },
    ScanIndexForward: false,
    Limit: limit,
  }));

  const alerts = ((res.Items ?? []) as SystemAlertItem[]).map((a) => ({
    id: a.PK.replace('ALERT#', ''),
    severity: a.severity,
    source: a.source,
    message: a.message,
    context: a.context ?? null,
    createdAt: a.createdAt,
  }));

  return json(200, { alerts });
}
