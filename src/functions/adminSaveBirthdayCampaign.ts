import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminSaveBirthdayCampaign
// Body: { monthId, giftTitle, giftValue, giftExpiryDays }
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { monthId?: unknown; giftTitle?: unknown; giftValue?: unknown; giftExpiryDays?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const monthId = typeof body.monthId === 'string' ? body.monthId.trim() : '';
  const giftTitle = typeof body.giftTitle === 'string' ? body.giftTitle : '';
  const giftValue = typeof body.giftValue === 'number' ? body.giftValue : 0;
  const giftExpiryDays = typeof body.giftExpiryDays === 'number' ? body.giftExpiryDays : null;
  if (!monthId) return json(400, { error: 'missing_month_id' });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `CAMPAIGN#${monthId}`, SK: 'METADATA' },
    UpdateExpression: 'SET giftTitle = :title, giftValue = :value, giftExpiryDays = :expiry, updatedAt = :now',
    ExpressionAttributeValues: {
      ':title': giftTitle, ':value': giftValue, ':expiry': giftExpiryDays, ':now': new Date().toISOString(),
    },
  }));

  return json(200, { success: true });
}
