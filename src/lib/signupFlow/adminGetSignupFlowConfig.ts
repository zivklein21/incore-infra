import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { loadSignupFlow } from './shared';
import { listTemplateHeads } from '../formTemplates/submissions';
import { signupCutoffs, withTemplateState } from '../formTemplates/signupTemplates';

// GET /adminGetSignupFlowConfig?brand=incore|forca
// Auth: Cognito JWT, admin only. The brand's First Sign-up Order steps,
// merged with its defaults (see normalizeSteps) — so it's never empty.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;
  const [steps, templates, cutoffs] = await Promise.all([loadSignupFlow(brand), listTemplateHeads(brand), signupCutoffs(brand)]);
  return json(200, { steps: withTemplateState(steps, templates), cutoffs });
}
