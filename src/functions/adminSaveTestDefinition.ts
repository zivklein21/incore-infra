import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { TestDefinitionItem } from '../lib/entities';

// POST /adminSaveTestDefinition
// Body: { id?: string, name: string, unit?: string, higherIsBetter: boolean,
//         active?: boolean } — omit id to create
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; unit?: unknown; higherIsBetter?: unknown; active?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  if (typeof body.higherIsBetter !== 'boolean') return json(400, { error: 'missing_higher_is_better' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTDEF#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as TestDefinitionItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: TestDefinitionItem = {
    PK: `TESTDEF#${id}`,
    SK: 'METADATA',
    name,
    ...(typeof body.unit === 'string' && body.unit.trim() ? { unit: body.unit.trim() } : {}),
    higherIsBetter: body.higherIsBetter,
    active: body.active === true,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
