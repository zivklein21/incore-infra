// EventBridge Scheduled Rule — unix-cron "10 0 1 * *" (00:10 on the 1st of
// the month), Asia/Jerusalem. See src/lib/birthdayGift.ts for the shared
// grant logic, also used by adminSendBirthdayGiftNow.ts.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { BirthdayCampaignItem } from '../lib/entities';
import { getAllMemberProfiles } from '../lib/memberScan';
import { jerusalemYMD, birthdayMonthId, parseBirthday, computeAge, resolveGift, applyGiftToMember, markRewarded } from '../lib/birthdayGift';

export async function handler(): Promise<void> {
  const now = new Date();
  const nowYMD = jerusalemYMD(now);
  const currentMonthId = birthdayMonthId(now);
  const campaignKey = { PK: `CAMPAIGN#${currentMonthId}`, SK: 'METADATA' };

  const campaignRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: campaignKey }));
  const campaign = campaignRes.Item as BirthdayCampaignItem | undefined;
  if (!campaign) {
    console.log(`[distributeBirthdayRewards] no active campaign for ${currentMonthId} — skipping`);
    return;
  }

  const gift = resolveGift(campaign, now);
  const alreadyRewarded = new Set(campaign.rewardedUsers ?? []);

  const profiles = await getAllMemberProfiles();
  const eligible: Array<{ id: string; birthdayYMD: { year: number; month: number; day: number } }> = [];

  for (const profile of profiles) {
    const memberId = profile.PK.replace('MEMBER#', '');
    if (alreadyRewarded.has(memberId)) continue;
    const birthday = parseBirthday(profile.identity?.birthday ?? profile.birthday);
    if (!birthday) continue;
    const birthdayYMD = jerusalemYMD(birthday);
    if (birthdayYMD.month !== nowYMD.month) continue;
    eligible.push({ id: memberId, birthdayYMD });
  }

  if (eligible.length === 0) {
    console.log(`[distributeBirthdayRewards] campaign=${currentMonthId} — no eligible members this run`);
    return;
  }

  const createdAtIso = new Date().toISOString();
  const msgExpiresAtMs = now.getTime() + 30 * 24 * 60 * 60 * 1000;
  const rewardedIds: string[] = [];

  await Promise.all(eligible.map(async ({ id, birthdayYMD }) => {
    await applyGiftToMember(id, currentMonthId, gift, createdAtIso, new Date(msgExpiresAtMs).toISOString(), Math.floor(msgExpiresAtMs / 1000));
    rewardedIds.push(id);
    console.log(`[distributeBirthdayRewards] rewarded member=${id} turning ${computeAge(birthdayYMD, nowYMD)}`);
  }));

  await markRewarded(campaignKey, rewardedIds);

  console.log(`[distributeBirthdayRewards] campaign=${currentMonthId} giftValue=${gift.giftValue} — rewarded ${rewardedIds.length} members`);
}
