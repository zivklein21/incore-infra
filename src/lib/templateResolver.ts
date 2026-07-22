import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { NotificationTemplateItem } from './entities';

export type TemplateType = 'CLASS_CANCEL' | 'CLASS_UPDATE' | 'BOOK_CANCEL' | 'REMINDER' | 'SPOT_IS_OPEN' | 'CUSTOM' | 'MEMBERSHIP_ALERT';
export type Lang = 'he' | 'en';

export interface TemplateVars {
  class_type: string;
  class_time: string;
  class_date: string;
  member_name: string;
  expiry_date?: string;
}

export interface ResolvedMessage {
  title: string;
  body: string;
  bgColor: string;
  textColor: string;
}

function applyVars(text: string, vars: TemplateVars): string {
  return text
    .replace(/\{class_type\}/g, vars.class_type)
    .replace(/\{class_time\}/g, vars.class_time)
    .replace(/\{class_date\}/g, vars.class_date)
    .replace(/\{member_name\}/g, vars.member_name)
    .replace(/\{expiry_date\}/g, vars.expiry_date ?? '');
}

// Ported as-is: the original took Limit(1) with no orderBy despite its
// docstring saying "most recently created" — Firestore's default order
// without orderBy isn't creation time either, so this preserves the same
// (arbitrary-if-more-than-one) selection behavior rather than "fixing" it
// into an explicit sort the original never actually had.
export async function resolveTemplate(
  type: TemplateType,
  lang: Lang,
  vars: TemplateVars,
): Promise<ResolvedMessage | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `TEMPLATETYPE#${type}` },
    Limit: 1,
  }));

  const tpl = (res.Items ?? [])[0] as NotificationTemplateItem | undefined;
  if (!tpl) return null;

  const rawTitle = lang === 'he'
    ? tpl.titleHe?.trim() || tpl.titleEn?.trim()
    : tpl.titleEn?.trim() || tpl.titleHe?.trim();

  const rawBody = lang === 'he'
    ? tpl.bodyHe?.trim() || tpl.bodyEn?.trim()
    : tpl.bodyEn?.trim() || tpl.bodyHe?.trim();

  return {
    title: applyVars(rawTitle || 'INCORE', vars),
    body: applyVars(rawBody || '', vars),
    bgColor: tpl.bgColor || '#5C3A8F',
    textColor: tpl.textColor || '#FFFFFF',
  };
}

export function getMemberLang(memberData: { preferredLanguage?: string }): Lang {
  return memberData.preferredLanguage === 'en' ? 'en' : 'he';
}

export function fmtTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' });
}

export function fmtDate(date: Date, lang: Lang): string {
  const locale = lang === 'he' ? 'he-IL' : 'en-US';
  return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
}
