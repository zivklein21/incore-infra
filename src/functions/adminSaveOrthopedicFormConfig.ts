import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminSaveOrthopedicFormConfig
// Body: { sections: FormSection[], brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, caller must be admin
//
// PK='APPCONFIG' SK='ORTHOPEDIC_FORM_CONFIG' — same key
// getOrthopedicFormConfig.ts reads. Overwrites the whole sections array,
// same "edit everything, then Save once" model as
// adminSaveRegistrationFormConfig.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { sections?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { sections } = body;
  if (!Array.isArray(sections)) return json(400, { error: 'invalid_argument' });
  const brand = body.brand === 'forca' ? 'forca' as const : 'incore' as const;

  await ddb.send(new PutCommand({
    TableName: tableForBrand(brand),
    Item: { PK: 'APPCONFIG', SK: 'ORTHOPEDIC_FORM_CONFIG', sections },
  }));

  return json(200, { success: true });
}
