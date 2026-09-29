import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ForcaBillingAgreementItem } from '../lib/entities';
import { setForcaAgreementStatus } from '../lib/forcaBillingAgreements';

// POST /adminSetForcaBillingAgreementStatus
// Auth: Cognito JWT, caller must be admin
// Body: { agreementId: string, status: 'active' | 'frozen' | 'cancelled' }
// See lib/forcaBillingAgreements.ts's setForcaAgreementStatus for the
// shared transition logic (also used by the parent-side freeze/cancel
// endpoints) — mirrors adminSetHypBillingAgreementStatus.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { agreementId?: unknown; status?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const agreementId = typeof body.agreementId === 'string' ? body.agreementId.trim() : '';
  const status = body.status === 'active' || body.status === 'frozen' || body.status === 'cancelled' ? body.status : '';
  if (!agreementId || !status) return json(400, { error: 'missing_fields', required: ['agreementId', 'status'] });

  const key = { PK: `FORCAAGREEMENT#${agreementId}`, SK: 'METADATA' };
  const agreementRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const agreement = agreementRes.Item as ForcaBillingAgreementItem | undefined;
  if (!agreement) return json(404, { error: 'agreement_not_found' });

  await setForcaAgreementStatus(agreement, status);

  console.log(`[adminSetForcaBillingAgreementStatus] agreement=${agreementId} -> ${status} by ${callerUid}`);
  return json(200, { success: true });
}
