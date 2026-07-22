import { randomUUID } from 'crypto';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { BirthdayCampaignItem } from './entities';

// jerusalemYMD/monthId: timeZone on an EventBridge cron only controls WHEN it
// fires — the container's own Date() still reports UTC. Ported unchanged
// from the original; matters most right at a month boundary in Jerusalem
// (UTC+2/+3), where plain now.getMonth() would compute the wrong month.
export function jerusalemYMD(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month') - 1, day: get('day') };
}

export function birthdayMonthId(d: Date): string {
  const { year, month } = jerusalemYMD(d);
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

export function parseBirthday(val: unknown): Date | null {
  if (!val) return null;
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function computeAge(
  birthdayYMD: { year: number; month: number; day: number },
  asOfYMD: { year: number; month: number; day: number },
): number {
  let age = asOfYMD.year - birthdayYMD.year;
  const monthDiff = asOfYMD.month - birthdayYMD.month;
  if (monthDiff < 0 || (monthDiff === 0 && asOfYMD.day < birthdayYMD.day)) age--;
  return age;
}

export interface ResolvedGift {
  giftTitle: string;
  giftValue: number;
  expiryIso: string | null;
}

export function resolveGift(campaign: BirthdayCampaignItem, now: Date): ResolvedGift {
  const giftTitle = campaign.giftTitle?.trim() || 'מתנת יום הולדת! 🥳';
  const giftValue = typeof campaign.giftValue === 'number' && campaign.giftValue > 0 ? campaign.giftValue : 1;
  const giftExpiryDays = typeof campaign.giftExpiryDays === 'number' && campaign.giftExpiryDays > 0 ? campaign.giftExpiryDays : null;

  let expiryIso: string | null = null;
  if (giftExpiryDays) {
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + giftExpiryDays);
    expiry.setHours(23, 59, 59, 999);
    expiryIso = expiry.toISOString();
  }

  return { giftTitle, giftValue, expiryIso };
}

// Writes the wallet grant (as a standalone PunchCardItem — same entity
// bookClass/cancelBooking read, so a birthday gift is immediately usable at
// checkout) + the notification message for one member. Shared by both the
// scheduled bulk run (distributeBirthdayRewards) and the admin's manual
// "send now" endpoint (adminSendBirthdayGiftNow) so the two paths can't drift.
export async function applyGiftToMember(
  memberId: string,
  monthKeyForMsg: string,
  gift: ResolvedGift,
  createdAtIso: string,
  msgExpiresAtIso: string,
  msgExpiresAtEpoch: number,
): Promise<void> {
  const body = `זכית ל-${gift.giftValue} כניסות מתנה ליום ההולדת שלך! 🎂`;
  const cardId = randomUUID();

  await Promise.all([
    ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${memberId}`,
        SK: `PUNCHCARD#${cardId}`,
        cardId,
        remainingPunches: gift.giftValue,
        expiryDate: gift.expiryIso,
        notes: gift.giftTitle,
        source: 'birthday_reward',
      },
    })),
    // Deterministic ID — prevents duplicate messages if a run retries.
    ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${memberId}`,
        SK: `MESSAGE#birthday_${monthKeyForMsg}`,
        type: 'birthday',
        title: gift.giftTitle,
        body,
        createdAt: createdAtIso,
        expiresAt: msgExpiresAtIso,
        expiresAtEpoch: msgExpiresAtEpoch,
        requiresAction: false,
        read: false,
      },
    })),
  ]);
}

export async function markRewarded(campaignKey: { PK: string; SK: string }, memberIds: string[]): Promise<void> {
  if (memberIds.length === 0) return;
  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: campaignKey,
    UpdateExpression: 'SET rewardedUsers = list_append(if_not_exists(rewardedUsers, :empty), :ids)',
    ExpressionAttributeValues: { ':ids': memberIds, ':empty': [] },
  }));
}
