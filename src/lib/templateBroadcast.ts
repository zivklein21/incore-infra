import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { NotificationTemplateItem, MemberProfileItem } from './entities';
import { getExpoPushToken } from './push';
import { getAllMemberProfiles } from './memberScan';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK_SIZE = 100;

interface PushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  data: Record<string, string>;
}

function resolvePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([^}]+)\}/g, (_, key: string) => vars[key] ?? '');
}

function deriveMemberName(profile: MemberProfileItem & { identity?: { name?: string; full_name?: string; first_name?: string; last_name?: string } }): string {
  const id = profile.identity;
  if (id?.name) return id.name;
  if (id?.full_name) return id.full_name;
  const first = id?.first_name ?? '';
  const last = id?.last_name ?? '';
  if (first || last) return `${first} ${last}`.trim();
  if (profile.name) return profile.name;
  return '';
}

function isMemberAdmin(profile: MemberProfileItem): boolean {
  return profile.identity?.role === 'admin' || profile.role === 'admin';
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

async function writeBroadcastLog(adminUserId: string, templateId: string, rawTitle: string, rawBody: string, dispatchedCount: number): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `BROADCASTLOG#${randomUUID()}`,
      SK: 'METADATA',
      adminUserId,
      templateId,
      rawTitle,
      rawBody,
      dispatchedCount,
      timestamp: new Date().toISOString(),
    },
  }));
}

// Shared broadcast core — used by both the admin-triggered HTTP endpoint
// (triggerTemplateAlert.ts) and, eventually, the automated
// scheduleAlertRoutine cron (functions/src/notificationTiming.ts, deferred
// pending its EventBridge migration) — one send path so the two can't drift.
export async function sendTemplateBroadcast(
  templateId: string,
  dynamicVariables: Record<string, string>,
  triggeredBy: string,
): Promise<{ success: boolean; dispatchedCount: number; error?: string }> {
  const templateRes = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TEMPLATE#${templateId}`, SK: 'METADATA' },
  }));
  const tpl = templateRes.Item as NotificationTemplateItem | undefined;
  if (!tpl) return { success: false, dispatchedCount: 0, error: 'template_not_found' };

  const rawTitle = tpl.titleHe?.trim() || tpl.titleEn?.trim() || 'INCORE';
  const rawBody = tpl.bodyHe?.trim() || tpl.bodyEn?.trim() || '';
  const bgColor = tpl.bgColor || '#5C3A8F';
  const textColor = tpl.textColor || '#FFFFFF';

  const allProfiles = await getAllMemberProfiles();
  const traineeProfiles = allProfiles.filter((p) => !isMemberAdmin(p));

  if (traineeProfiles.length === 0) {
    await writeBroadcastLog(triggeredBy, templateId, rawTitle, rawBody, 0);
    return { success: true, dispatchedCount: 0 };
  }

  const nowMs = Date.now();
  const broadcastId = `blast_${templateId}_${nowMs}`;
  const expiresAtMs = nowMs + 7 * 24 * 60 * 60 * 1000;

  const pushMessages: PushMessage[] = [];

  await Promise.all(traineeProfiles.map(async (profile) => {
    const memberId = profile.PK.replace('MEMBER#', '');
    const memberName = deriveMemberName(profile);
    const allVars: Record<string, string> = { ...dynamicVariables, member_name: memberName };

    const memberTitle = resolvePlaceholders(rawTitle, allVars);
    const memberBody = resolvePlaceholders(rawBody, allVars);

    const token = getExpoPushToken(profile);
    if (token) {
      pushMessages.push({ to: token, title: memberTitle, body: memberBody, sound: 'default', data: { type: 'broadcast', templateId } });
    }

    // suppressPush=true: the message-created notification path (deferred —
    // see notifications.ts) is expected to skip push since it's handled here.
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `MEMBER#${memberId}`,
        SK: `MESSAGE#${broadcastId}`,
        type: 'broadcast',
        title: memberTitle,
        body: memberBody,
        bgColor,
        textColor,
        templateId,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtEpoch: Math.floor(expiresAtMs / 1000),
        requiresAction: false,
        read: false,
        suppressPush: true,
      },
    }));
  }));

  const msgChunks = chunk(pushMessages, EXPO_CHUNK_SIZE);
  let dispatchedCount = 0;

  for (const batch of msgChunks) {
    try {
      const resp = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      const result = await resp.json();
      console.log(`[sendTemplateBroadcast] batch (${batch.length}):`, JSON.stringify(result));
      dispatchedCount += batch.length;
    } catch (err: any) {
      console.error('[sendTemplateBroadcast] push batch failed:', err);
    }
  }

  await writeBroadcastLog(triggeredBy, templateId, rawTitle, rawBody, dispatchedCount);

  console.log(`[sendTemplateBroadcast] by=${triggeredBy} template=${templateId} trainees=${traineeProfiles.length} pushed=${dispatchedCount}`);
  return { success: true, dispatchedCount };
}
