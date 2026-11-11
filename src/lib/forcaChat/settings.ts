import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';

// FORCA chat settings, set by the admin in the Backoffice (Chat → gear, FORCA
// mode). Separate from INCORE's APPCONFIG/SUPPORT_SETTINGS. Kept in the FORCA
// table at APPCONFIG / FORCA_CHAT_SETTINGS.
//
//   subjects        the subject chips a member picks from
//   autoReply       added by the server to every new conversation to the admin
//   coachAutoReply  added to every new conversation to a coach
// An empty text means no auto-reply for that recipient. Until the admin saves
// anything, the defaults below apply (as INCORE's app falls back to its own).

export interface ForcaChatSettings {
  subjects: string[];
  autoReply: string;
  coachAutoReply: string;
}

export const FORCA_CHAT_DEFAULTS: ForcaChatSettings = {
  subjects: ['שאלה על מנוי', 'דיווח על פציעה', 'אחר'],
  autoReply: 'שלום! קיבלנו את פנייתך 🙏 נחזור אליך בהקדם האפשרי. — צוות FORCA',
  coachAutoReply: 'היי! קיבלתי את ההודעה שלך 🙏 אחזור אלייך בהקדם.',
};

const KEY = { PK: 'APPCONFIG', SK: 'FORCA_CHAT_SETTINGS' };
const MAX_TEXT = 1000;
const MAX_SUBJECTS = 20;

/** Stored item -> settings, field by field, defaults for anything never saved. */
export function parseForcaChatSettings(item: Record<string, unknown> | undefined): ForcaChatSettings {
  if (!item) return { ...FORCA_CHAT_DEFAULTS, subjects: [...FORCA_CHAT_DEFAULTS.subjects] };
  const subjects = Array.isArray(item.subjects) ? item.subjects.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];
  return {
    subjects: subjects.length ? subjects : [...FORCA_CHAT_DEFAULTS.subjects],
    autoReply: typeof item.autoReply === 'string' ? item.autoReply : FORCA_CHAT_DEFAULTS.autoReply,
    coachAutoReply: typeof item.coachAutoReply === 'string' ? item.coachAutoReply : FORCA_CHAT_DEFAULTS.coachAutoReply,
  };
}

/** Validates an admin's save. Null when the body isn't usable. */
export function validateForcaChatSettings(body: { subjects?: unknown; autoReply?: unknown; coachAutoReply?: unknown }): ForcaChatSettings | null {
  if (!Array.isArray(body.subjects) || typeof body.autoReply !== 'string') return null;
  if (body.coachAutoReply !== undefined && typeof body.coachAutoReply !== 'string') return null;
  const subjects = Array.from(new Set(body.subjects.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean)));
  if (!subjects.length || subjects.length > MAX_SUBJECTS) return null;
  const autoReply = body.autoReply.trim();
  const coachAutoReply = typeof body.coachAutoReply === 'string' ? body.coachAutoReply.trim() : FORCA_CHAT_DEFAULTS.coachAutoReply;
  if (autoReply.length > MAX_TEXT || coachAutoReply.length > MAX_TEXT) return null;
  return { subjects, autoReply, coachAutoReply };
}

/** The auto-reply for a new conversation to this recipient, or null for none. */
export function autoReplyFor(settings: ForcaChatSettings, recipientRole: 'admin' | 'coach'): string | null {
  const text = (recipientRole === 'admin' ? settings.autoReply : settings.coachAutoReply).trim();
  return text || null;
}

export async function getForcaChatSettings(): Promise<ForcaChatSettings> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: KEY }));
  return parseForcaChatSettings(res.Item as Record<string, unknown> | undefined);
}

export async function saveForcaChatSettings(settings: ForcaChatSettings, byUid: string): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: FORCA_TABLE_NAME,
    Item: { ...KEY, ...settings, updatedAt: new Date().toISOString(), updatedBy: byUid },
  }));
}
