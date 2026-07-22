import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { NotificationTemplateItem } from '../lib/entities';

// GET or POST /getNotificationTemplates
// Auth: Cognito JWT, caller must be admin
//
// Small, admin-managed table (a handful of bilingual per-event templates) —
// a full Scan is fine, same as other small-config-table reads in this repo.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'TEMPLATE#', ':metadata': 'METADATA' },
  }));

  const templates = ((res.Items ?? []) as NotificationTemplateItem[]).map((t) => ({
    // Derived from the primary key, not the templateId attribute — a row
    // written before adminSaveNotificationTemplate.ts existed (or by any
    // path that didn't set it) would otherwise come back with id:
    // undefined, producing duplicate/missing React list keys client-side.
    id: t.PK.replace('TEMPLATE#', ''),
    type: t.type,
    titleHe: t.titleHe,
    titleEn: t.titleEn,
    bodyHe: t.bodyHe,
    bodyEn: t.bodyEn,
    bgColor: t.bgColor,
    textColor: t.textColor,
  }));

  return json(200, { templates });
}
