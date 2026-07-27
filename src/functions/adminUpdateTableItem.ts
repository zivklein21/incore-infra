import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { isRestrictedForGenericEdit } from '../lib/adminConfig';

// POST /adminUpdateTableItem
// Auth: Cognito JWT, caller must be admin
// Body: { pk: string, sk: string, item: Record<string, unknown> }
//
// Full-item overwrite (PutCommand) from the Table Data Viewer's JSON
// editor — the caller sends back the whole edited document, not a partial
// patch, since the editor shows/edits raw JSON. attribute_exists(PK) stops
// this from silently switching from "edit" to "create" if the item was
// deleted between the viewer loading it and the admin saving (the FE shows
// a confirmation modal either way, but the condition is the real guard).
// isRestrictedForGenericEdit blocks entity types with dedicated admin
// handlers that enforce invariants a raw overwrite would break — see
// adminConfig.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { pk?: unknown; sk?: unknown; item?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const pk = typeof body.pk === 'string' ? body.pk : '';
  const sk = typeof body.sk === 'string' ? body.sk : '';
  if (!pk || !sk) return json(400, { error: 'missing_key' });
  if (typeof body.item !== 'object' || body.item === null || Array.isArray(body.item)) {
    return json(400, { error: 'invalid_item' });
  }
  if (isRestrictedForGenericEdit(pk)) {
    return json(403, { error: 'restricted_entity_type', message: 'Use the dedicated admin screen for this entity type.' });
  }

  const item = { ...(body.item as Record<string, unknown>), PK: pk, SK: sk };

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: 'attribute_exists(PK)',
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return json(404, { error: 'not_found' });
    throw err;
  }

  return json(200, { success: true });
}
