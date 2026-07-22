import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminSaveRegistrationFormConfig
// Body: { sections: FormSection[] }
// Auth: Cognito JWT, caller must be admin
//
// PK='APPCONFIG' SK='REGISTRATION_FORM_CONFIG' — same key
// getRegistrationFormConfig.ts reads, same "one item per config type under
// a shared PK" convention as saveSupportSettings.ts. Overwrites the whole
// sections array — matches the editor screen's "edit everything, then Save
// once" model, no per-question partial update.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { sections?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { sections } = body;
  if (!Array.isArray(sections)) return json(400, { error: 'invalid_argument' });

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { PK: 'APPCONFIG', SK: 'REGISTRATION_FORM_CONFIG', sections },
  }));

  return json(200, { success: true });
}
