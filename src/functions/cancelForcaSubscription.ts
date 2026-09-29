import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ForcaBillingAgreementItem } from '../lib/entities';
import { setForcaAgreementStatus } from '../lib/forcaBillingAgreements';

// POST /cancelForcaSubscription
// Auth: Cognito JWT — a parent cancelling a linked daughter's subscription
// (family-link-verified). Body: { agreementId: string }
//
// Deletes the saved card token and stops all future billing, but
// deliberately leaves the trainee's current paid-through period (see
// profile.membership, the real access gate) untouched — per the FORCA
// billing spec, cancellation keeps the current active period fully valid
// and usable until the end of the paid cycle.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { agreementId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const agreementId = typeof body.agreementId === 'string' ? body.agreementId.trim() : '';
  if (!agreementId) return json(400, { error: 'missing_agreement_id' });

  const key = { PK: `FORCAAGREEMENT#${agreementId}`, SK: 'METADATA' };
  const agreementRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const agreement = agreementRes.Item as ForcaBillingAgreementItem | undefined;
  if (!agreement) return json(404, { error: 'agreement_not_found' });

  const link = await verifyFamilyLink(callerUid, agreement.userId);
  if (!link.ok) return json(403, { error: 'forbidden' });
  if (agreement.status === 'cancelled') return json(200, { success: true });

  await setForcaAgreementStatus(agreement, 'cancelled');

  console.log(`[cancelForcaSubscription] agreement=${agreementId} cancelled by parent=${callerUid}`);
  return json(200, { success: true });
}
