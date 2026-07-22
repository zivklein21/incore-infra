import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { HypBillingAgreementItem } from '../lib/entities';
import { firstOfNextMonth } from '../lib/entities';

// POST /adminSetHypBillingAgreementStatus
// Auth: Cognito JWT, caller must be admin
// Body: { agreementId: string, status: 'active' | 'paused' | 'cancelled' }
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { agreementId?: unknown; status?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const agreementId = typeof body.agreementId === 'string' ? body.agreementId.trim() : '';
  const status = body.status === 'active' || body.status === 'paused' || body.status === 'cancelled' ? body.status : '';
  if (!agreementId || !status) return json(400, { error: 'missing_fields', required: ['agreementId', 'status'] });

  const key = { PK: `AGREEMENT#${agreementId}`, SK: 'METADATA' };
  const agreementRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const agreement = agreementRes.Item as HypBillingAgreementItem | undefined;
  if (!agreement) return json(404, { error: 'agreement_not_found' });

  const nowIso = new Date().toISOString();

  if (status === 'active') {
    const current = agreement.nextChargeDate;
    const nextChargeDate = (!current || new Date(current) < new Date()) ? firstOfNextMonth(new Date()).toISOString() : current;
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET #status = :active, consecutiveFailures = :zero, updatedAt = :now, nextChargeDate = :ncd, GSI3PK = :g3pk, GSI3SK = :ncd',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':zero': 0, ':now': nowIso, ':ncd': nextChargeDate, ':g3pk': 'AGREEMENT_STATUS#active' },
    }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET #status = :status, consecutiveFailures = :zero, updatedAt = :now REMOVE GSI3PK, GSI3SK',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':zero': 0, ':now': nowIso },
    }));
  }

  console.log(`[adminSetHypBillingAgreementStatus] agreement=${agreementId} -> ${status} by ${callerUid}`);
  return json(200, { success: true });
}
