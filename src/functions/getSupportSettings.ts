import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getForcaChatSettings } from '../lib/forcaChat/settings';

// GET or POST /getSupportSettings
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
// ?brand=forca (app 1.5.2+): FORCA's own chat settings (lib/forcaChat/settings.ts),
// with coachAutoReply too. Without it: INCORE's, exactly as before.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  if (event.queryStringParameters?.brand === 'forca') return json(200, await getForcaChatSettings());

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
