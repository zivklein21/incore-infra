import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { normalizeSections, normalizeSettings, TemplateValidationError } from './schema';
import { renderFormPdf } from './pdf/renderFormPdf';
import { brandLogo, storePreviewPdf } from './signedPdf';
import { parseBrand } from './shared';

// POST /adminPreviewFormPdf
// Body: { id?: string, name: string, sections: TemplateSection[], settings?: { code }, version?: number }
// Auth: Cognito JWT, admin only. The builder's "Preview PDF": renders the
// (possibly unsaved) draft exactly like a signed copy, but with dummy data
// in every field and a SAMPLE watermark on every page, and returns a
// presigned URL to it (stored under previews/, expired by a lifecycle rule
// after a day — never a signed document).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  let body: { id?: unknown; name?: unknown; sections?: unknown; settings?: unknown; version?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const brand = parseBrand(body.brand);
  let sections;
  try {
    sections = normalizeSections(body.sections ?? [], 'parent');
  } catch (err) {
    if (err instanceof TemplateValidationError) return json(400, { error: 'invalid_argument', detail: err.message });
    throw err;
  }
  const settings = normalizeSettings((body.settings && typeof body.settings === 'object' ? body.settings : {}) as Record<string, unknown>, 'either');
  const bytes = await renderFormPdf({
    title: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'טופס ללא שם',
    code: settings.code,
    numberQuestions: settings.numberQuestions === true,
    version: typeof body.version === 'number' && body.version > 0 ? body.version : 1,
    sections,
    answers: {},
    signatures: [],
    submissionId: 'SAMPLE',
    childName: brand === 'forca' ? 'מתאמנת לדוגמה' : 'מתאמן/ת לדוגמה',
    generatedAt: new Date(),
    sample: true,
    brand,
    logoPng: await brandLogo(brand),
  });
  const url = await storePreviewPdf(brand, bytes, typeof body.id === 'string' && body.id ? body.id : 'draft');
  return json(200, { url });
}
