import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { saveForcaChatSettings, validateForcaChatSettings } from '../lib/forcaChat/settings';

// POST /saveSupportSettings
// Auth: Cognito JWT, caller must be admin
// Body { brand: 'forca', subjects, autoReply, coachAutoReply } (app 1.5.2+)
// saves FORCA's chat settings instead; without brand, INCORE's as before.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'permission-denied' });

  let body: { subjects?: unknown; autoReply?: unknown; coachAutoReply?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid-argument' });
  }

  if (body.brand === 'forca') {
    const settings = validateForcaChatSettings(body);
    if (!settings) return json(400, { error: 'invalid-argument' });
    await saveForcaChatSettings(settings, uid);
    return json(200, { success: true });
  }

  const { subjects, autoReply } = body;
  if (!Array.isArray(subjects) || typeof autoReply !== 'string') {
    return json(400, { error: 'invalid-argument' });
  }

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { PK: 'APPCONFIG', SK: 'SUPPORT_SETTINGS', subjects, autoReply },
  }));

  return json(200, { success: true });
}
