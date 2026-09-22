import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { sendTemplateBroadcast, type BroadcastAudience } from '../lib/templateBroadcast';

// POST /triggerTemplateAlert
// Body: { templateId: string, dynamicVariables?: Record<string,string>,
//         brand?: 'incore' | 'forca', audience?: 'children' | 'parents' | 'both' }
// Auth: Cognito JWT, caller must be admin
// brand comes from the admin's Backoffice toggle (AdminBrandModeContext) —
// picks which table the template is read from and who it's broadcast to
// (see sendTemplateBroadcast.ts). audience is FORCA's Family Accounts split
// (Notification Timing screen) — harmless no-op for INCORE, which never
// sends anything but 'both'.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'Forbidden: admin access required' });

  let body: { templateId?: unknown; dynamicVariables?: unknown; brand?: unknown; audience?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing templateId' });
  }

  const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
  const dynamicVariables = body.dynamicVariables !== null && typeof body.dynamicVariables === 'object' && !Array.isArray(body.dynamicVariables)
    ? (body.dynamicVariables as Record<string, string>)
    : {};
  const brand = body.brand === 'forca' ? 'forca' as const : 'incore' as const;
  const audience: BroadcastAudience = body.audience === 'children' || body.audience === 'parents' ? body.audience : 'both';

  if (!templateId) return json(400, { error: 'Missing templateId' });

  const result = await sendTemplateBroadcast(templateId, dynamicVariables, adminUid, brand, audience);
  if (!result.success) return json(404, { error: result.error });

  return json(200, { success: true, dispatchedCount: result.dispatchedCount });
}
