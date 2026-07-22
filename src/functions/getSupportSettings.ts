import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// GET or POST /getSupportSettings
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: 'APPCONFIG', SK: 'SUPPORT_SETTINGS' },
  }));

  if (!res.Item) return json(200, { subjects: [], autoReply: '' });

  return json(200, {
    subjects: Array.isArray(res.Item.subjects) ? res.Item.subjects : [],
    autoReply: typeof res.Item.autoReply === 'string' ? res.Item.autoReply : '',
  });
}
