import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// GET or POST /getTermsOfServiceContent
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
//
// PK='APPCONFIG' SK='TERMS_OF_SERVICE' — same "one item per config type
// under a shared PK" convention as getSupportSettings.ts. Returns an empty
// parts list until the admin has saved once — the client's
// DEFAULT_POLICY_PARTS fallback stays client-side for now.
//
// `parts` is a list of { title, sections } chapters (e.g. Terms of Use /
// Privacy Policy) — was a flat `sections` array before parts existed;
// renamed alongside that migration since nothing else reads this field.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: 'APPCONFIG', SK: 'TERMS_OF_SERVICE' },
  }));

  return json(200, {
    parts: Array.isArray(res.Item?.parts) ? res.Item.parts : [],
    checkboxes: Array.isArray(res.Item?.checkboxes) ? res.Item.checkboxes : [],
  });
}
