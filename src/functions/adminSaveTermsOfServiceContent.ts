import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { isConflict, saveVersionedConfig } from '../lib/configVersions';

// POST /adminSaveTermsOfServiceContent
// Body: {
//   parts: { title: string; sections: { title: string; body: string; subsections?: [...nested] }[] }[],
//   checkboxes?: string[],   // free-form "list of approval" items
//   brand?: 'incore' | 'forca',
// }
// Auth: Cognito JWT, caller must be admin
//
// PK='APPCONFIG' SK='TERMS_OF_SERVICE' — same key getTermsOfServiceContent.ts
// reads, same brand-aware (tableForBrand) convention. Overwrites the whole
// parts array (and checkboxes list, when provided) for that brand only —
// FORCA and INCORE each get their own independent Terms of Service.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { parts?: unknown; checkboxes?: unknown; brand?: unknown };
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
  const brand = body.brand === 'forca' ? 'forca' as const : 'incore' as const;

  const content: Record<string, unknown> = { parts };
  if (checkboxes !== undefined) content.checkboxes = checkboxes;

  // Versioned like the other form configs (lib/configVersions.ts). A new
  // version never re-asks anyone to agree — acceptPolicies.ts's own
  // agreedToPolicies flag is untouched by this.
  try {
    const { version, published } = await saveVersionedConfig({
      table: tableForBrand(brand), sk: 'TERMS_OF_SERVICE', content, contentKeys: ['parts', 'checkboxes'], uid,
    });
    return json(200, { success: true, version, published });
  } catch (err) {
    if (isConflict(err)) return json(409, { error: 'conflict' });
    throw err;
  }
}
