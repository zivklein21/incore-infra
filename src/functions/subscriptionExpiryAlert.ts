// EventBridge Scheduled Rule — unix-cron "0 20 28-31 * *" (20:00 on days
// 28-31), Asia/Jerusalem; exits unless today is the actual last day of the month.
import { randomUUID } from 'crypto';
import { ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem } from '../lib/entities';
import { monthKey } from '../lib/entities';
import { getAllMemberProfiles } from '../lib/memberScan';
import { getExpoPushToken } from '../lib/push';

const EXPIRY_TITLE = '⏰ תזכורת: המנוי שלך מסתיים הלילה!';
const EXPIRY_BODY = 'מחר מתחיל חודש חדש וזה הזמן לחדש את המנוי שלך ב-INCORE כדי להבטיח את מקומך באימונים הקרובים. היכנסי לאפליקציה להסדרת המנוי! 🤍';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function handler(): Promise<void> {
  const now = new Date();

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (tomorrow.getMonth() === now.getMonth()) {
    console.log('[subscriptionExpiryAlert] not the last day of the month — exiting');
    return;
  }

  const currentMonth = monthKey(now);
  const nextMonth = monthKey(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  console.log(`[subscriptionExpiryAlert] start — currentMonth=${currentMonth} nextMonth=${nextMonth}`);

  // ── Step 1: current-month ACTIVE memberships (cross-member scan) ──────────
  const currentMemberships: MembershipItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND #status = :active AND targetMonth = :month',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE', ':month': currentMonth },
      ExclusiveStartKey: lastKey,
    }));
    currentMemberships.push(...(res.Items ?? []) as MembershipItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const membershipByMember = new Map<string, MembershipItem>();
  for (const m of currentMemberships) membershipByMember.set(m.PK.replace('MEMBER#', ''), m);
  const candidateIds = [...membershipByMember.keys()];

  const allProfiles = await getAllMemberProfiles();
  const profileById = new Map(allProfiles.map((p) => [p.PK.replace('MEMBER#', ''), p]));

  // ── Step 2/3: filter already-alerted; check next-month existence ─────────
  const toAlert = new Set<string>();

  await Promise.all(candidateIds.map(async (memberId) => {
    const profile = profileById.get(memberId);
    if (!profile) return;
    if (profile.subscriptionExpiryAlertSent === currentMonth) return;

    const currentMem = membershipByMember.get(memberId)!;
    if (currentMem.isAutoRenew === false) {
      toAlert.add(memberId);
      return;
    }

    const nextRes = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'PK = :pk AND begins_with(SK, :prefix) AND targetMonth = :month',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#', ':month': nextMonth },
    }));
    if ((nextRes.Items ?? []).length === 0) toAlert.add(memberId);
  }));

  // CASE 2b: inline membership.status === 'expiring'
  for (const profile of allProfiles) {
    if (profile.membership?.status === 'expiring') {
      const memberId = profile.PK.replace('MEMBER#', '');
      if (profile.subscriptionExpiryAlertSent !== currentMonth) toAlert.add(memberId);
    }
  }

  if (toAlert.size === 0) {
    console.log('[subscriptionExpiryAlert] no members to alert — done');
    return;
  }
  console.log(`[subscriptionExpiryAlert] flagging ${toAlert.size} members`);

  const nowIso = new Date().toISOString();
  const msgExpiresAtMs = Date.now() + 12 * 3_600_000;
  const pushTokens: string[] = [];
  const dbWrites: Array<() => Promise<unknown>> = [];

  for (const memberId of toAlert) {
    const profile = profileById.get(memberId);
    if (!profile) continue;

    const token = getExpoPushToken(profile);
    if (token) pushTokens.push(token);

    dbWrites.push(() => ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${memberId}`,
        SK: `MESSAGE#expiry_alert_${currentMonth}`,
        type: 'admin_alert',
        title: EXPIRY_TITLE,
        body: EXPIRY_BODY,
        bgColor: '#5C3A8F',
        textColor: '#FFFFFF',
        createdAt: nowIso,
        expiresAt: new Date(msgExpiresAtMs).toISOString(),
        expiresAtEpoch: Math.floor(msgExpiresAtMs / 1000),
        requiresAction: false,
        read: false,
        suppressPush: true,
      },
    })));

    dbWrites.push(() => ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
      UpdateExpression: 'SET subscriptionExpiryAlertSent = :m',
      ExpressionAttributeValues: { ':m': currentMonth },
    })));
  }

  let totalPushed = 0;
  for (const batch of chunk(pushTokens, EXPO_CHUNK)) {
    try {
      const resp = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map((to) => ({ to, title: EXPIRY_TITLE, body: EXPIRY_BODY, sound: 'default' as const, data: { type: 'subscription_expiry_alert' } }))),
      });
      await resp.json();
      totalPushed += batch.length;
      console.log(`[subscriptionExpiryAlert] push batch ${batch.length} sent`);
    } catch (err: any) {
      console.error('[subscriptionExpiryAlert] push batch error:', err);
    }
  }

  await Promise.all(dbWrites.map((fn) => fn()));

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `BROADCASTLOG#${randomUUID()}`,
      SK: 'METADATA',
      type: 'SUBSCRIPTION_EXPIRY_ALERT',
      targetMonth: currentMonth,
      totalUsersAlerted: toAlert.size,
      totalPushed,
      timestamp: nowIso,
    },
  }));

  console.log(`[subscriptionExpiryAlert] done — alerted=${toAlert.size} pushed=${totalPushed}`);
}
