import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminSetForceShowPaymentButton
// Body: { memberId, enabled: boolean } — forces the renewal payment button
// to show in the member's app regardless of the automatic 1st-of-month
// schedule. Cleared automatically once the member saves a card again
// (see hypPaymentCallback.ts / createHypTokenPurchase.ts).
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; enabled?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const enabled = body.enabled === true;
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key, ConsistentRead: true }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const admin = { ...(profile.admin ?? {}) } as Record<string, unknown>;
  if (enabled) {
    admin.forceShowPaymentButton = true;
  } else {
    delete admin.forceShowPaymentButton;
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET admin = :admin',
    ExpressionAttributeValues: { ':admin': admin },
  }));

  return json(200, { success: true, forceShowPaymentButton: enabled });
}
