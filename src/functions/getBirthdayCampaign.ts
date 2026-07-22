import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { BirthdayCampaignItem } from '../lib/entities';

// GET or POST /getBirthdayCampaign?monthId=YYYY-MM
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const monthId = event.queryStringParameters?.monthId;
  if (!monthId) return json(400, { error: 'missing_month_id' });

  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CAMPAIGN#${monthId}`, SK: 'METADATA' } }));
  const item = res.Item as BirthdayCampaignItem | undefined;
  if (!item) return json(200, null);

  return json(200, {
    giftTitle: item.giftTitle ?? null,
    giftValue: item.giftValue ?? null,
    giftExpiryDays: item.giftExpiryDays ?? null,
    rewardedUsers: item.rewardedUsers ?? [],
  });
}
