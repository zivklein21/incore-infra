import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { NotificationTemplateItem } from '../lib/entities';

// GET or POST /getNotificationTemplates?brand=incore|forca (or { brand } in
// a POST body)
// Auth: Cognito JWT, admin, or a coach with permissions.notifications ===
// 'write' (Coach Role epic — her Notifications screen browses the same
// FORCA templates admin authored, before picking one to send to her own
// trainees via sendCoachNotification.ts). A coach is always forced to
// brand='forca' regardless of what she passes — she must never read the
// INCORE table's templates.
//
// brand picks which table to scan (see the FORCA data separation plan) —
// an admin has no member profile brand to fall back on the way
// getProducts.ts does, so this defaults to 'incore' when omitted, same as
// adminSaveNotificationTemplate.ts/adminDeleteNotificationTemplate.ts.
// Small, admin-managed table (a handful of bilingual per-event templates) —
// a full Scan is fine, same as other small-config-table reads in this repo.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  const access = await getCoachAccess(uid);
  if (!access || (!access.isAdmin && access.permissions.notifications === 'none')) return json(403, { error: 'forbidden' });

  let bodyBrand: unknown;
  if (event.body) {
    try { bodyBrand = (JSON.parse(event.body) as { brand?: unknown }).brand; } catch { /* ignore */ }
  }
  const brand = !access.isAdmin || event.queryStringParameters?.brand === 'forca' || bodyBrand === 'forca'
    ? 'forca' as const : 'incore' as const;

  const res = await ddb.send(new ScanCommand({
    TableName: tableForBrand(brand),
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
