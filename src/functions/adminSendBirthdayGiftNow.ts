import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { BirthdayCampaignItem } from '../lib/entities';
import { birthdayMonthId, resolveGift, applyGiftToMember, markRewarded } from '../lib/birthdayGift';

// POST /adminSendBirthdayGiftNow
// Body: { memberId }
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_fields', required: ['memberId'] });

  const now = new Date();
  const currentMonthId = birthdayMonthId(now);
  const campaignKey = { PK: `CAMPAIGN#${currentMonthId}`, SK: 'METADATA' };

  try {
    const [campaignRes, memberRes] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: campaignKey })),
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } })),
    ]);

    const campaign = campaignRes.Item as BirthdayCampaignItem | undefined;
    if (!campaign) return json(400, { error: 'no_active_campaign' });
    if (!memberRes.Item) return json(404, { error: 'member_not_found' });

    const alreadyRewarded = new Set(campaign.rewardedUsers ?? []);
    if (alreadyRewarded.has(memberId)) return json(400, { error: 'already_rewarded' });

    const gift = resolveGift(campaign, now);
    const createdAtIso = new Date().toISOString();
    const msgExpiresAtMs = now.getTime() + 30 * 24 * 60 * 60 * 1000;

    await applyGiftToMember(memberId, currentMonthId, gift, createdAtIso, new Date(msgExpiresAtMs).toISOString(), Math.floor(msgExpiresAtMs / 1000));
    await markRewarded(campaignKey, [memberId]);

    console.log(`[adminSendBirthdayGiftNow] admin=${adminUid} member=${memberId} campaign=${currentMonthId}`);
    return json(200, { success: true });
  } catch (err: any) {
    console.error('[adminSendBirthdayGiftNow] failed', err);
    return json(500, { error: 'internal_error' });
  }
}
