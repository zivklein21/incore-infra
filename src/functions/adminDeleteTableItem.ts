import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { isRestrictedForGenericEdit } from '../lib/adminConfig';

// POST /adminDeleteTableItem
// Auth: Cognito JWT, caller must be admin
// Body: { pk: string, sk: string }
// Same restricted-entity-type guard as adminUpdateTableItem.ts — deleting a
// MEMBER#/ORDER#/AGREEMENT#/CLASS# item outside its dedicated admin flow
// (adminDeleteMember, adminRefundOrder, ...) would leave denormalized
// counters/GSI entries/Cognito state behind.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { pk?: unknown; sk?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const pk = typeof body.pk === 'string' ? body.pk : '';
  const sk = typeof body.sk === 'string' ? body.sk : '';
  if (!pk || !sk) return json(400, { error: 'missing_key' });
  if (isRestrictedForGenericEdit(pk)) {
    return json(403, { error: 'restricted_entity_type', message: 'Use the dedicated admin screen for this entity type.' });
  }

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: sk } }));

  return json(200, { success: true });
}
