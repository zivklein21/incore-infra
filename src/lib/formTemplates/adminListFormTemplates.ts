import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { FORM_TEMPLATE_SK_PREFIX, fromStored, parseBrand } from './shared';
import { listSubmissionsOfTemplate } from './submissions';

// GET /adminListFormTemplates?brand=incore|forca
// Auth: Cognito JWT, admin only. Every custom template's CURRENT version
// (schema v2 — legacy templates converted on the fly, see fromStored),
// oldest first — the client lists the built-in Registration/Orthopedic
// forms ahead of these itself. Each carries its draft content (the head),
// status (draft/published/archived), publishedVersion, whether the draft
// has unpublished changes, its settings, and — FORCA — how many families
// have signed it (signedCount).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });

  const brand = parseBrand(event.queryStringParameters?.brand);
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: tableForBrand(brand),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': 'APPCONFIG', ':prefix': FORM_TEMPLATE_SK_PREFIX },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const heads = items
    .map(item => {
      const { legacy: _legacy, ...template } = fromStored(item, brand);
      return { ...template, hasUnpublishedChanges: template.contentHash !== template.publishedHash };
    })
    .filter(t => t.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const templates = await Promise.all(heads.map(async t => ({
    ...t,
    signedCount: brand === 'forca'
      ? (await listSubmissionsOfTemplate(t.id)).filter(s => s.signatures.length > 0 || s.acknowledgments.length > 0).length
      : 0,
  })));

  return json(200, { templates });
}
