import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { getAllMemberProfiles } from '../lib/memberScan';
import { getExpoPushToken, sendExpoPush } from '../lib/push';
import { deriveMemberName, type NotificationTemplateItem } from '../lib/entities';

function resolvePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([^}]+)\}/g, (_, key: string) => vars[key] ?? '');
}

// POST /sendCoachNotification
// Auth: Cognito JWT, admin or a coach with permissions.notifications ===
// 'write'. Coach Role epic, item 7 ("תזמון התראות") — she browses the same
// FORCA templates admin authored (getNotificationTemplates.ts) and sends
// one to only her own assigned-group trainees. Deliberately NOT built on
// the admin's broadcast path (triggerTemplateAlert.ts/
// sendTemplateBroadcast.ts) — those are all-trainees-by-design (no group/
// coach scoping concept exists there at all), and reusing them would also
// hand a coach that same all-trainees reach.
//
// Body: { templateId: string } (preferred — resolves title/body from the
// FORCA template, same {member_name} placeholder support as
// sendTemplateBroadcast.ts) OR { title: string, body: string } for a raw
// ad-hoc send (kept for flexibility, not currently exposed in the UI).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.notifications === 'none') return json(403, { error: 'forbidden' });

  const parsed = JSON.parse(event.body ?? '{}') as { templateId?: string; title?: string; body?: string };

  let rawTitle: string;
  let rawBody: string;
  if (parsed.templateId) {
    const templateRes = await ddb.send(new GetCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `TEMPLATE#${parsed.templateId}`, SK: 'METADATA' },
    }));
    const tpl = templateRes.Item as NotificationTemplateItem | undefined;
    if (!tpl) return json(404, { error: 'template_not_found' });
    rawTitle = tpl.titleHe?.trim() || tpl.titleEn?.trim() || 'FORCA';
    rawBody = tpl.bodyHe?.trim() || tpl.bodyEn?.trim() || '';
  } else {
    rawTitle = (parsed.title ?? '').trim();
    rawBody = (parsed.body ?? '').trim();
  }
  if (!rawTitle || !rawBody) return json(400, { error: 'title_and_body_required' });

  const allProfiles = await getAllMemberProfiles(FORCA_TABLE_NAME);
  const trainees = allProfiles.filter((p) => {
    const role = p.identity?.role ?? p.role;
    if (role === 'admin' || role === 'coach') return false;
    return groupInAccess(access, p.identity?.groupId);
  });

  if (trainees.length === 0) return json(200, { dispatchedCount: 0 });

  const nowMs = Date.now();
  const broadcastId = `coachmsg_${randomUUID()}`;
  const expiresAtMs = nowMs + 7 * 24 * 60 * 60 * 1000;

  let dispatchedCount = 0;
  await Promise.all(trainees.map(async (profile) => {
    const memberId = profile.PK.replace('MEMBER#', '');
    const memberName = deriveMemberName(profile);
    const title = resolvePlaceholders(rawTitle, { member_name: memberName });
    const bodyText = resolvePlaceholders(rawBody, { member_name: memberName });

    // suppressPush=true: the message-created notification path is expected
    // to skip push since it's sent directly below, same convention as
    // sendTemplateBroadcast.ts's own MESSAGE# writes.
    await ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: {
        PK: `MEMBER#${memberId}`,
        SK: `MESSAGE#${broadcastId}`,
        type: 'broadcast',
        title,
        body: bodyText,
        bgColor: '#7A004B',
        textColor: '#FFFFFF',
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtEpoch: Math.floor(expiresAtMs / 1000),
        requiresAction: false,
        read: false,
        suppressPush: true,
      },
    }));

    const token = getExpoPushToken(profile);
    if (token) {
      await sendExpoPush(token, title, bodyText, { type: 'coach_broadcast' });
      dispatchedCount += 1;
    }
  }));

  console.log(`[sendCoachNotification] by=${callerUid} trainees=${trainees.length} pushed=${dispatchedCount}`);
  return json(200, { dispatchedCount });
}
