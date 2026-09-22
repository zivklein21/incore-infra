import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';

// GET or POST /getTermsOfServiceContent?brand=incore|forca
// Auth: Cognito JWT (any signed-in member — no admin check in the original)
//
// PK='APPCONFIG' SK='TERMS_OF_SERVICE' — same "one item per config type
// under a shared PK" convention as getSupportSettings.ts, but brand-aware
// (tableForBrand) since FORCA's Terms of Service is genuinely different
// content from INCORE's (a youth training program agreement, not a gym
// membership/class-package policy) — previously this always read the plain
// INCORE table regardless of caller brand, so every FORCA trainee was
// shown/signing INCORE's gym terms on PoliciesAgreementScreen. Defaults to
// 'incore' for callers that don't pass brand yet. Returns an empty parts
// list until the admin has saved once for that brand — the client's own
// per-brand default fallback stays client-side.
//
// `parts` is a list of { title, sections } chapters (e.g. Terms of Use /
// Privacy Policy) — was a flat `sections` array before parts existed;
// renamed alongside that migration since nothing else reads this field.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  getUid(event); // enforces the JWT authorizer already ran; matches original's auth-only check

  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;

  const res = await ddb.send(new GetCommand({
    TableName: tableForBrand(brand),
    Key: { PK: 'APPCONFIG', SK: 'TERMS_OF_SERVICE' },
  }));

  return json(200, {
    parts: Array.isArray(res.Item?.parts) ? res.Item.parts : [],
    checkboxes: Array.isArray(res.Item?.checkboxes) ? res.Item.checkboxes : [],
  });
}
