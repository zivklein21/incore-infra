import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { tableForBrand } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { isConflict, saveVersionedConfig } from '../lib/configVersions';

// POST /adminSaveRegistrationFormConfig
// Body: { sections: FormSection[], brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, caller must be admin
//
// PK='APPCONFIG' SK='REGISTRATION_FORM_CONFIG' — same key
// getRegistrationFormConfig.ts reads, same brand-aware split
// (tableForBrand) adminSaveOrthopedicFormConfig.ts already uses — INCORE
// and FORCA each get their own independently-editable question set.
// Overwrites the whole sections array — matches the editor screen's "edit
// everything, then Save once" model, no per-question partial update.
// Each content change also publishes an immutable version
// (lib/configVersions.ts) — earlier submissions keep counting as complete;
// nobody is asked to fill the form again because it changed.
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

  try {
    const { version, published } = await saveVersionedConfig({
      table: tableForBrand(brand), sk: 'REGISTRATION_FORM_CONFIG', content: { sections }, contentKeys: ['sections'], uid,
    });
    return json(200, { success: true, version, published });
  } catch (err) {
    if (isConflict(err)) return json(409, { error: 'conflict' });
    throw err;
  }
}
