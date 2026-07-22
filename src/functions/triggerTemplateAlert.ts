import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { sendTemplateBroadcast } from '../lib/templateBroadcast';

// POST /triggerTemplateAlert
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'Forbidden: admin access required' });

  let body: { templateId?: unknown; dynamicVariables?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'Missing templateId' });
  }

  const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
  const dynamicVariables = body.dynamicVariables !== null && typeof body.dynamicVariables === 'object' && !Array.isArray(body.dynamicVariables)
    ? (body.dynamicVariables as Record<string, string>)
    : {};

  if (!templateId) return json(400, { error: 'Missing templateId' });

  const result = await sendTemplateBroadcast(templateId, dynamicVariables, adminUid);
  if (!result.success) return json(404, { error: result.error });

  return json(200, { success: true, dispatchedCount: result.dispatchedCount });
}
