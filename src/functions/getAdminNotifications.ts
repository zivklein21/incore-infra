import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET or POST /getAdminNotifications
// Query/body: { brand?: 'incore' | 'forca' } — the Backoffice's currently
// active brand tab (see AdminBrandModeContext.tsx), so admin only sees
// that brand's own notifications while viewing it, never the other
// brand's mixed in. Every notification the write side (notifyAdmins() in
// lib/adminNotify.ts) creates is tagged with a `brand`; a legacy row
// written before that tag existed has none and is treated as 'incore' (the
// only brand that wrote any before FORCA's own alerts existed), so nothing
// pre-existing silently disappears from either view. Omitting `brand`
// entirely returns everything unfiltered — kept for any caller that hasn't
// been updated to pass it yet.
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

  const rawBrand = event.queryStringParameters?.brand
    ?? (event.body ? (JSON.parse(event.body) as { brand?: unknown }).brand : undefined);
  const brand = rawBrand === 'incore' || rawBrand === 'forca' ? rawBrand : undefined;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    FilterExpression: 'isRead = :false',
    ExpressionAttributeValues: { ':pk': 'ADMINNOTIF', ':false': false },
  }));

  const items = (res.Items ?? []) as Record<string, unknown>[];
  const filtered = brand ? items.filter((n) => (n.brand ?? 'incore') === brand) : items;

  const notifications = filtered.map((n) => ({
    id: (n.PK as string).replace('NOTIFICATION#', ''),
    type: n.type,
    priority: n.priority,
    title: n.title,
    message: n.message,
    createdAt: n.createdAt,
    // Payment-failure alerts only — undefined for other notification types.
    memberId: n.memberId,
  }));

  return json(200, { notifications });
}
