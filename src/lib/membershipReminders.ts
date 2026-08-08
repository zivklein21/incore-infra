import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { deriveMemberName, type MemberProfileItem } from './entities';
import { resolveTemplate, getMemberLang, type TemplateType } from './templateResolver';

// Returns YYYY-MM-DD in Israel timezone, offset by `days` from today.
export function israelDateStrOffset(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

export function formatExpiryForLocale(dateStr: string, lang: 'he' | 'en'): string {
  // Parse as noon UTC so timezone shifts don't flip the day.
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem',
  });
}

export function membershipEndStr(profile: MemberProfileItem): string | null {
  const end = profile.membership?.end;
  return typeof end === 'string' && end ? end.slice(0, 10) : null;
}

export async function sendReminder(
  memberId: string,
  profile: MemberProfileItem,
  type: TemplateType,
  endStr: string,
): Promise<void> {
  const lang = getMemberLang(profile);
  const memberName = deriveMemberName(profile);

  const msg = await resolveTemplate(type, lang, {
    class_type: '', class_time: '', class_date: '',
    member_name: memberName,
    expiry_date: formatExpiryForLocale(endStr, lang),
  });
  if (!msg) {
    console.warn(`[membershipReminders] no template for type=${type}, skipping ${memberId}`);
    return;
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
      type,
      createdAt: new Date().toISOString(),
    },
  }));
}
