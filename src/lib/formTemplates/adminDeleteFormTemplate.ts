import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { formTemplateKey, parseBrand } from './shared';

// POST /adminDeleteFormTemplate
// Body: { id: string, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only. Hard delete of a custom template. The
// built-in Registration/Orthopedic forms aren't stored under this key
// prefix, so they can't be deleted through here.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return json(400, { error: 'missing_id' });

  await ddb.send(new DeleteCommand({ TableName: tableForBrand(parseBrand(body.brand)), Key: formTemplateKey(id) }));

  return json(200, { success: true });
}
