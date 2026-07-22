import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminSaveTermsOfServiceContent
// Body: {
//   parts: { title: string; sections: { title: string; body: string; subsections?: [...nested] }[] }[],
//   checkboxes?: string[]   // free-form "list of approval" items
// }
// Auth: Cognito JWT, caller must be admin
//
// PK='APPCONFIG' SK='TERMS_OF_SERVICE' — same key getTermsOfServiceContent.ts
// reads, same "one item per config type under a shared PK" convention as
// adminSaveRegistrationFormConfig.ts. Overwrites the whole parts array
// (and checkboxes list, when provided).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { parts?: unknown; checkboxes?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { parts, checkboxes } = body;
  if (!Array.isArray(parts)) return json(400, { error: 'invalid_argument' });
  if (checkboxes !== undefined && !Array.isArray(checkboxes)) {
    return json(400, { error: 'invalid_argument' });
  }

  const item: Record<string, unknown> = { PK: 'APPCONFIG', SK: 'TERMS_OF_SERVICE', parts };
  if (checkboxes !== undefined) item.checkboxes = checkboxes;

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return json(200, { success: true });
}
