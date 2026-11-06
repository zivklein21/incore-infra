import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isAdmin } from './auth';
import { ddb, tableForBrand } from './dynamo';
import { getUid, json } from './http';
import { logArchiveEvent } from './memberArchive';

// POST /adminSetMemberTestFlag
// Body: { memberId, isTest, brand }
// Auth: admin. Deleting a test account keeps nothing (memberDeletion.ts), so
// every change is logged with who made it.
export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; isTest?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId || typeof body.isTest !== 'boolean') return json(400, { error: 'invalid_argument' });

  try {
    await ddb.send(new UpdateCommand({
      TableName: tableForBrand(body.brand === 'forca' ? 'forca' : 'incore'),
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
      ConditionExpression: 'attribute_exists(PK)',
      UpdateExpression: 'SET isTest = :isTest',
      ExpressionAttributeValues: { ':isTest': body.isTest },
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return json(404, { error: 'member_not_found' });
    throw err;
  }
  await logArchiveEvent({ event: 'test_flag_changed', memberId, kind: 'member', detail: String(body.isTest), by: uid });
  return json(200, { success: true, isTest: body.isTest });
}
