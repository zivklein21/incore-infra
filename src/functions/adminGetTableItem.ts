import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET /adminGetTableItem?pk=PRODUCT%23123&sk=METADATA
// Auth: Cognito JWT, caller must be admin
// Single-item fetch backing the Table Data Viewer's row-detail/JSON view.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const pk = event.queryStringParameters?.pk;
  const sk = event.queryStringParameters?.sk;
  if (!pk || !sk) return json(400, { error: 'missing_key' });

  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: sk } }));
  if (!res.Item) return json(404, { error: 'not_found' });

  return json(200, { item: res.Item });
}
