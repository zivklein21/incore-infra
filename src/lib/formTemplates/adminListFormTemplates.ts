import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { FORM_TEMPLATE_SK_PREFIX, fromStored, parseBrand } from './shared';

// GET /adminListFormTemplates?brand=incore|forca
// Auth: Cognito JWT, admin only. Every custom template's CURRENT version
// (schema v2 — legacy templates converted on the fly, see fromStored),
// oldest first — the client lists the built-in Registration/Orthopedic
// forms ahead of these itself.
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

  const templates = items
    .map(item => {
      const { legacy: _legacy, ...template } = fromStored(item, brand);
      return template;
    })
    .filter(t => t.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return json(200, { templates });
}
