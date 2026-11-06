import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { isConflict, saveVersionedConfig } from '../configVersions';
import { formWordingSk, isWordingFormId, normalizeTexts } from './shared';

// POST /adminSaveFormWording
// Body: { formId: 'health' | 'parental_consent', texts: WordingTexts, brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only. Replaces the form's whole override set
// (an empty entry = back to the app's default text). Each change publishes
// a version (lib/configVersions.ts). Returns { version, published }.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { formId?: unknown; texts?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!isWordingFormId(body.formId)) return json(400, { error: 'invalid_form' });
  const texts = normalizeTexts(body.texts);
  if (!texts) return json(400, { error: 'invalid_argument' });
  const brand = body.brand === 'forca' ? 'forca' : 'incore';

  try {
    const { version, published } = await saveVersionedConfig({
      table: tableForBrand(brand), sk: formWordingSk(body.formId), content: { texts }, contentKeys: ['texts'], uid,
    });
    return json(200, { success: true, version, published });
  } catch (err) {
    if (isConflict(err)) return json(409, { error: 'conflict' });
    throw err;
  }
}
