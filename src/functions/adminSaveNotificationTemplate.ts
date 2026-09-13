import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminSaveNotificationTemplate
// Body: { id?: string, type, titleHe, titleEn, bodyHe, bodyEn, bgColor,
//         textColor, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, caller must be admin
// brand comes from the admin's Backoffice toggle (AdminBrandModeContext),
// same pattern as adminSaveProduct.ts — picks which table this template is
// written to (see the FORCA data separation plan).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const type = typeof body.type === 'string' ? body.type : '';
  if (!type) return json(400, { error: 'missing_type' });
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const nowIso = new Date().toISOString();
  const brand = body.brand === 'forca' ? 'forca' as const : 'incore' as const;

  await ddb.send(new PutCommand({
    TableName: tableForBrand(brand),
    Item: {
      PK: `TEMPLATE#${id}`,
      SK: 'METADATA',
      GSI1PK: `TEMPLATETYPE#${type}`,
      GSI1SK: `TEMPLATE#${id}`,
      templateId: id,
      type,
      titleHe: typeof body.titleHe === 'string' ? body.titleHe : '',
      titleEn: typeof body.titleEn === 'string' ? body.titleEn : '',
      bodyHe: typeof body.bodyHe === 'string' ? body.bodyHe : '',
      bodyEn: typeof body.bodyEn === 'string' ? body.bodyEn : '',
      bgColor: typeof body.bgColor === 'string' ? body.bgColor : '#5C3A8F',
      textColor: typeof body.textColor === 'string' ? body.textColor : '#FFFFFF',
      createdAt: typeof body.createdAt === 'string' ? body.createdAt : nowIso,
      updatedAt: nowIso,
    },
  }));

  return json(200, { success: true, id });
}
