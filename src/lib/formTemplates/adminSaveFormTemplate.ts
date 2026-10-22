import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { formTemplateKey, parseBrand } from './shared';

// POST /adminSaveFormTemplate
// Body: { id?: string, name: string, sections: FormSection[], brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only. Creates (no id) or overwrites a custom
// template — same "edit everything, then Save once" model as
// adminSaveRegistrationFormConfig.ts. Returns the saved id.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; sections?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  if (!Array.isArray(body.sections)) return json(400, { error: 'invalid_argument' });
  const table = tableForBrand(parseBrand(body.brand));

  const now = new Date().toISOString();
  const existingId = typeof body.id === 'string' && body.id ? body.id : '';
  const id = existingId || randomUUID();
  let createdAt = now;
  if (existingId) {
    const existing = await ddb.send(new GetCommand({ TableName: table, Key: formTemplateKey(id) }));
    if (!existing.Item) return json(404, { error: 'not_found' });
    createdAt = String(existing.Item.createdAt ?? now);
  }

  await ddb.send(new PutCommand({
    TableName: table,
    Item: { ...formTemplateKey(id), id, name, sections: body.sections, createdAt, updatedAt: now },
  }));

  return json(200, { success: true, id });
}
