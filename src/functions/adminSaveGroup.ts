import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { GroupItem } from '../lib/entities';

// POST /adminSaveGroup
// Body: { id?: string, name: string, description?: string, price?: number, sessionsPerWeek?: number } — omit id to create
// Auth: Cognito JWT, caller must be admin
// FORCA-only — Groups (training cohorts) live in the FORCA table exclusively.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; name?: unknown; description?: unknown; price?: unknown; sessionsPerWeek?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { error: 'missing_name' });
  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  // A PutCommand replaces the whole item, so a rename has to carry the
  // original createdAt/createdBy forward explicitly rather than omitting
  // them and hoping they survive.
  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `GROUP#${existingId}`, SK: 'METADATA' } }));
    const existing = existingRes.Item as GroupItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const item: GroupItem = {
    PK: `GROUP#${id}`,
    SK: 'METADATA',
    name,
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    ...(typeof body.price === 'number' ? { price: body.price } : {}),
    ...(typeof body.sessionsPerWeek === 'number' ? { sessionsPerWeek: body.sessionsPerWeek } : {}),
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, name });
}
