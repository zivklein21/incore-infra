import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';
import { resolveTemplate, getMemberLang } from '../lib/templateResolver';
import { israelDateStrOffset, formatExpiryForLocale, membershipEndStr } from '../lib/membershipReminders';

// GET /testMembershipReminder?memberId=xxx
// Debug/test endpoint — no auth in the original, ported as-is and flagged.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const memberId = event.queryStringParameters?.memberId ?? '';
  if (!memberId) return json(400, { error: 'missing memberId query param' });

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  const profile = memberRes.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member not found' });

  const endStr = membershipEndStr(profile);
  const token = profile.device?.expoPushToken ?? profile.device?.expo_push_token ?? profile.expoPushToken ?? null;

  const today7 = israelDateStrOffset(7);
  const today3 = israelDateStrOffset(3);
  const lang = getMemberLang(profile);

  const log = {
    memberId,
    membershipEnd: endStr,
    today7,
    today3,
    expoPushToken: token ?? 'MISSING',
    templateQuery: 'notificationTemplates where type == MEMBERSHIP_ALERT',
  };

  const msg = await resolveTemplate('MEMBERSHIP_ALERT', lang, {
    class_type: '', class_time: '', class_date: '',
    member_name: profile.identity?.name ?? '',
    expiry_date: endStr ? formatExpiryForLocale(endStr, lang) : '',
  });

  if (!msg) {
    return json(200, { ...log, result: 'NO_TEMPLATE — create a notificationTemplates item with type="MEMBERSHIP_ALERT"' });
  }

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `MEMBER#${memberId}`,
      SK: `MESSAGE#${randomUUID()}`,
      title: msg.title,
      body: msg.body,
      bgColor: msg.bgColor,
      textColor: msg.textColor,
      type: 'MEMBERSHIP_ALERT',
      createdAt: new Date().toISOString(),
    },
  }));

  return json(200, { ...log, result: 'SENT', title: msg.title, body: msg.body });
}
