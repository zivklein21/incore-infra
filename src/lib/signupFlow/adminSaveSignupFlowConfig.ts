import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { normalizeSteps, signupFlowKey } from './shared';

// POST /adminSaveSignupFlowConfig
// Body: { steps: { formId: string, included: boolean }[], brand?: 'incore' | 'forca' }
// Auth: Cognito JWT, admin only. Overwrites the brand's whole order (same
// "edit everything, then Save once" model as the form config editors).
// Unknown/duplicate formIds are dropped and any missing built-in form is
// re-appended (normalizeSteps), so a bad payload can't remove a form.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });

  let body: { steps?: unknown; brand?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!Array.isArray(body.steps)) return json(400, { error: 'invalid_argument' });
  const brand = body.brand === 'forca' ? 'forca' as const : 'incore' as const;

  const steps = normalizeSteps(brand, body.steps);
  await ddb.send(new PutCommand({
    TableName: tableForBrand(brand),
    Item: { ...signupFlowKey, steps, updatedAt: new Date().toISOString() },
  }));

  return json(200, { success: true, steps });
}
