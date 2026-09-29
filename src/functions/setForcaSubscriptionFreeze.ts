import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ForcaBillingAgreementItem } from '../lib/entities';
import { setForcaAgreementStatus } from '../lib/forcaBillingAgreements';

// POST /setForcaSubscriptionFreeze
// Auth: Cognito JWT — a parent freezing or lifting the freeze on a linked
// daughter's subscription (family-link-verified). Body: { agreementId:
// string, freeze: boolean } — freeze: true sets 'frozen', false sets
// 'active'. See the FORCA billing spec: freeze/unfreeze is explicitly
// something both admin AND the parent can do, unlike cancel-vs-purchase
// which stays admin/parent-respectively-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { agreementId?: unknown; freeze?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const agreementId = typeof body.agreementId === 'string' ? body.agreementId.trim() : '';
  if (!agreementId) return json(400, { error: 'missing_agreement_id' });
  const freeze = body.freeze === true;

  const key = { PK: `FORCAAGREEMENT#${agreementId}`, SK: 'METADATA' };
  const agreementRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const agreement = agreementRes.Item as ForcaBillingAgreementItem | undefined;
  if (!agreement) return json(404, { error: 'agreement_not_found' });

  const link = await verifyFamilyLink(callerUid, agreement.userId);
  if (!link.ok) return json(403, { error: 'forbidden' });
  if (agreement.status === 'cancelled') return json(400, { error: 'already_cancelled' });

  await setForcaAgreementStatus(agreement, freeze ? 'frozen' : 'active');

  console.log(`[setForcaSubscriptionFreeze] agreement=${agreementId} freeze=${freeze} by parent=${callerUid}`);
  return json(200, { success: true });
}
