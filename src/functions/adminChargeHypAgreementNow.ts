import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypBillingAgreementItem } from '../lib/entities';
import { chargeOneAgreement } from '../lib/hypBillingAgreements';

// POST /adminChargeHypAgreementNow
// Auth: Cognito JWT, caller must be admin
// Body: { agreementId: string }
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { agreementId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const agreementId = typeof body.agreementId === 'string' ? body.agreementId.trim() : '';
  if (!agreementId) return json(400, { error: 'missing_fields', required: ['agreementId'] });

  const agreementRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `AGREEMENT#${agreementId}`, SK: 'METADATA' } }));
  const agreement = agreementRes.Item as HypBillingAgreementItem | undefined;
  if (!agreement) return json(404, { error: 'agreement_not_found' });

  // chargeOneAgreement unconditionally sets status back to 'active' on a
  // successful charge (see hypBillingAgreements.ts), which would silently
  // un-pause an agreement the admin deliberately paused, and resume future
  // auto-billing — reject those cases up front instead.
  if (agreement.status === 'paused') return json(409, { error: 'agreement_paused', message: 'Resume the agreement before charging it.' });
  if (agreement.status === 'cancelled') return json(409, { error: 'agreement_cancelled' });

  const result = await chargeOneAgreement(agreement);
  console.log(`[adminChargeHypAgreementNow] agreement=${agreementId} triggeredBy=${callerUid} success=${result.success}`);
  return json(200, result);
}
