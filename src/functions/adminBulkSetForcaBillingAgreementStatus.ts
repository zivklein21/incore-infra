import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ForcaBillingAgreementItem } from '../lib/entities';
import { setForcaAgreementStatus } from '../lib/forcaBillingAgreements';

// POST /adminBulkSetForcaBillingAgreementStatus
// Auth: Cognito JWT, caller must be admin
// Body: { status: 'active' | 'frozen' }
// "Freeze All" (status='frozen') acts on every currently-active-or-failed
// agreement; "Unfreeze All" (status='active') acts only on agreements
// currently frozen — deliberately never touches 'cancelled' agreements in
// either direction, since a cancellation is a deliberate, final action a
// bulk toggle shouldn't silently reverse. Reuses the same per-agreement
// transition helper as the single-agreement endpoint
// (adminSetForcaBillingAgreementStatus.ts) so freeze/unfreeze semantics
// (GSI3 drop/restore, nextChargeDate) stay in exactly one place.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { status?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const status = body.status === 'active' || body.status === 'frozen' ? body.status : '';
  if (!status) return json(400, { error: 'missing_fields', required: ['status'] });

  const targetCurrentStatuses: ForcaBillingAgreementItem['status'][] =
    status === 'frozen' ? ['active', 'failed'] : ['frozen'];

  const items: ForcaBillingAgreementItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': 'FORCAAGREEMENT' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []) as ForcaBillingAgreementItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const targets = items.filter(a => targetCurrentStatuses.includes(a.status));
  for (const agreement of targets) {
    await setForcaAgreementStatus(agreement, status);
  }

  console.log(`[adminBulkSetForcaBillingAgreementStatus] status=${status} updated=${targets.length} by ${callerUid}`);
  return json(200, { success: true, updated: targets.length });
}
