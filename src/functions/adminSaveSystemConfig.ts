import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { EDITABLE_APPCONFIG_KEYS } from '../lib/adminConfig';

// POST /adminSaveSystemConfig
// Auth: Cognito JWT, caller must be admin
// Body: { key: one of EDITABLE_APPCONFIG_KEYS, fields: Record<string, unknown>, expectedVersion?: number }
//
// Partial update (UpdateCommand, not a full-item Put) so saving one field
// from the Config screen's form can't clobber sibling fields written by a
// different admin action (e.g. saveSupportSettings.ts writing
// SUPPORT_SETTINGS directly). expectedVersion is optional
// optimistic-concurrency: if the caller read a version first (the Config
// screen always does, via adminGetSystemConfig), a stale write is rejected
// with 409 rather than silently overwriting a concurrent admin's change.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { key?: unknown; fields?: unknown; expectedVersion?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const key = typeof body.key === 'string' ? body.key : '';
  if (!(EDITABLE_APPCONFIG_KEYS as readonly string[]).includes(key)) {
    return json(400, { error: 'invalid_config_key' });
  }
  if (typeof body.fields !== 'object' || body.fields === null || Array.isArray(body.fields)) {
    return json(400, { error: 'invalid_fields' });
  }
  const fields = body.fields as Record<string, unknown>;
  const fieldEntries = Object.entries(fields).filter(([k]) => k !== 'PK' && k !== 'SK' && k !== 'version');
  if (fieldEntries.length === 0) return json(400, { error: 'no_fields' });

  const setClauses = ['#version = if_not_exists(#version, :zero) + :one', '#updatedAt = :updatedAt', '#updatedBy = :updatedBy'];
  const names: Record<string, string> = { '#version': 'version', '#updatedAt': 'updatedAt', '#updatedBy': 'updatedBy' };
  const values: Record<string, unknown> = { ':zero': 0, ':one': 1, ':updatedAt': new Date().toISOString(), ':updatedBy': callerUid };

  fieldEntries.forEach(([k, v], i) => {
    const nameKey = `#f${i}`;
    const valueKey = `:v${i}`;
    names[nameKey] = k;
    values[valueKey] = v;
    setClauses.push(`${nameKey} = ${valueKey}`);
  });

  const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
  if (expectedVersion !== undefined) values[':expectedVersion'] = expectedVersion;

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: 'APPCONFIG', SK: key },
      UpdateExpression: `SET ${setClauses.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: expectedVersion !== undefined
        ? 'attribute_not_exists(#version) OR #version = :expectedVersion'
        : undefined,
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return json(409, { error: 'stale_version' });
    throw err;
  }

  return json(200, { success: true });
}
