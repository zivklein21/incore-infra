import { createHash } from 'crypto';
import { israelDateStrOf, ISRAEL_TZ } from '../israelTime';

// FORCA parent cancellation requests (בקשה לביטול השתתפות): the pure rules.
//
// Legal rules this follows:
//  1. A request is RECEIVED the moment it's submitted. Or never approves
//     receipt, and no date waits for her handling.
//  2. Requests that reached Or by WhatsApp, phone, email, mail or another
//     valid channel are valid too: she enters them with the ORIGINAL date and time.
//  3. Only Or changes participation, stops charges, sets an end date or refunds.
//     A request itself never cancels or stops anything.
//  4. The parent's status never says a request wasn't received because Or
//     hasn't handled it yet: every request starts as "הבקשה התקבלה".
//
// End date (section 5.8 of the terms): the suggested last active day is the
// last day of the month the request was received in (Israel time); the stop
// day is the 1st of the next month. Or may choose later (with a warning).

export const REQUEST_STATUSES = ['received', 'in_progress', 'end_date_set', 'done'] as const;
/** cancellation (task 4) or medical_freeze (section 8, lib/forcaMedicalFreeze). Older records have no type: cancellation. */
export const REQUEST_TYPES = ['cancellation', 'medical_freeze'] as const;
export type RequestType = typeof REQUEST_TYPES[number];
export const REQUEST_TYPE_LABEL: Record<RequestType, string> = { cancellation: 'ביטול השתתפות', medical_freeze: 'הקפאה רפואית' };
export type RequestStatus = typeof REQUEST_STATUSES[number];

export const CHANNELS = ['app', 'whatsapp', 'phone', 'email', 'mail', 'other'] as const;
export type Channel = typeof CHANNELS[number];
export const MANUAL_CHANNELS: Channel[] = ['whatsapp', 'phone', 'email', 'mail', 'other'];

/** What the parent sees. Never anything that suggests the request wasn't received. */
export function parentStatusLabel(status: RequestStatus, endDate?: string | null): string {
  switch (status) {
    case 'in_progress': return 'בטיפול';
    case 'end_date_set': return endDate ? `מועד סיום שנקבע: ${formatDay(endDate)}` : 'בטיפול';
    case 'done': return 'הטיפול הושלם';
    default: return 'הבקשה התקבלה';
  }
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  app: 'אפליקציה', whatsapp: 'WhatsApp', phone: 'טלפון', email: 'מייל', mail: 'דואר', other: 'ערוץ אחר',
};

/** Open = Or still has something to do. */
export const isOpenStatus = (s: RequestStatus) => s !== 'done';
export const listPartition = (s: RequestStatus) => `FORCACANCELREQ#${isOpenStatus(s) ? 'open' : 'handled'}`;

// ─── Dates ──────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" → "DD/MM/YYYY". */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

/** ISO → "DD/MM/YYYY HH:mm", Israel time. */
export function formatIsraelDateTime(iso: string): string {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: ISRAEL_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${formatDay(israelDateStrOf(d))} ${time}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function endOfMonthOf(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

export function firstOfNextMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

export type Suggestion58 = { receivedDay: string; lastActiveDay: string; stopDay: string };

/** Section 5.8: active until the end of the month the request was received in. */
export function suggestedEnd(receivedAt: string): Suggestion58 {
  const receivedDay = israelDateStrOf(new Date(receivedAt));
  const lastActiveDay = endOfMonthOf(receivedDay);
  return { receivedDay, lastActiveDay, stopDay: firstOfNextMonth(receivedDay) };
}

export const LATE_WARNING = 'מאוחר מהמועד לפי סעיף 5.8 – לוודא שההורה ביקש זאת';
export const SUGGESTION_LABEL = 'מועד מוצע לפי סעיף 5.8';

/** Whether an end Or picked is later than section 5.8's. */
export const isLaterThan58 = (lastActiveDay: string | null, s: Suggestion58) => !!lastActiveDay && lastActiveDay > s.lastActiveDay;

export type ChargeLike = { orderId: string; amount: number; createdAt: string; status?: string; productName?: string };
export type FlaggedCharge = ChargeLike & { day: string; mayNeedRefund: boolean };

/**
 * Completed charges made after the request was received. One made for a
 * month after the suggested end is flagged "ייתכן שנדרש החזר". Never refunded
 * automatically.
 */
export function chargesAfterReceipt(charges: ChargeLike[], receivedAt: string): FlaggedCharge[] {
  const s = suggestedEnd(receivedAt);
  const t = new Date(receivedAt).getTime();
  return charges
    .filter((c) => (c.status ?? 'completed') === 'completed' && new Date(c.createdAt).getTime() > t)
    .map((c) => {
      const day = israelDateStrOf(new Date(c.createdAt));
      return { ...c, day, mayNeedRefund: day > s.lastActiveDay };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export const MAY_NEED_REFUND = 'ייתכן שנדרש החזר';

// ─── Input checks ───────────────────────────────────────────────────────────

const MAX_NOTE = 1000;
const MAX_CONTENT = 2000;
const MAX_TEMPLATE = 2000;
/** How far back a manual request's original time may be. */
const MAX_MANUAL_AGE_DAYS = 400;

export function cleanNote(raw: unknown): { ok: true; note: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, note: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_note' };
  const note = raw.trim();
  if (note.length > MAX_NOTE) return { ok: false, error: 'note_too_long' };
  return { ok: true, note };
}

export type ManualInput = { parentUid: string; childUid: string; channel: Channel; originalAt: string; content: string; notifyParent: boolean };

export function validateManual(body: Record<string, unknown>, now: Date): { ok: true; value: ManualInput } | { ok: false; error: string } {
  const parentUid = typeof body.parentUid === 'string' ? body.parentUid.trim() : '';
  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!parentUid || !childUid) return { ok: false, error: 'missing_parent_or_child' };
  if (!MANUAL_CHANNELS.includes(body.channel as Channel)) return { ok: false, error: 'invalid_channel' };
  const originalAt = typeof body.originalAt === 'string' ? new Date(body.originalAt) : null;
  if (!originalAt || Number.isNaN(originalAt.getTime())) return { ok: false, error: 'invalid_original_at' };
  if (originalAt.getTime() > now.getTime() + 60_000) return { ok: false, error: 'original_at_in_future' };
  if (now.getTime() - originalAt.getTime() > MAX_MANUAL_AGE_DAYS * 86_400_000) return { ok: false, error: 'original_at_too_old' };
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (content.length < 2) return { ok: false, error: 'content_required' };
  if (content.length > MAX_CONTENT) return { ok: false, error: 'content_too_long' };
  return {
    ok: true,
    value: { parentUid, childUid, channel: body.channel as Channel, originalAt: originalAt.toISOString(), content, notifyParent: body.notifyParent !== false },
  };
}

/** Or's manual status change. end_date_set needs the date; the cancel sheet sets it by itself. */
export function validateStatusChange(body: Record<string, unknown>): { ok: true; status: RequestStatus; endDate: string | null } | { ok: false; error: string } {
  const status = body.status as RequestStatus;
  if (!REQUEST_STATUSES.includes(status)) return { ok: false, error: 'invalid_status' };
  if (status === 'end_date_set') {
    const d = body.endDate;
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'end_date_required' };
    return { ok: true, status, endDate: d };
  }
  return { ok: true, status, endDate: null };
}

// ─── Texts Or edits ─────────────────────────────────────────────────────────

export interface RequestSettings {
  /** What the parent submits. {{childName}} is filled in. */
  requestText: string;
  /** Sent to the parent on receipt. {{childName}}, {{receivedAt}}, {{requestNumber}}. */
  confirmationText: string;
  /** The same two for a medical freeze notice. */
  medicalRequestText: string;
  medicalConfirmationText: string;
}

export const DEFAULT_SETTINGS: RequestSettings = {
  requestText: 'אני מבקש/ת לבטל את השתתפותה של {{childName}} בפעילות FORCA.',
  confirmationText:
    'בקשתך לביטול ההשתתפות של {{childName}} התקבלה ב-{{receivedAt}} (מספר בקשה {{requestNumber}}).\n'
    + 'הבקשה אינה מבטלת את המנוי באופן מיידי: מועד סיום ההשתתפות ייקבע לפי תנאי השימוש, ועדכון יופיע באפליקציה.',
  medicalRequestText: 'הודעה על הקפאה רפואית של {{childName}}. מצורף אישור רפואי.',
  medicalConfirmationText:
    'הודעתך על הקפאה רפואית של {{childName}} התקבלה ב-{{receivedAt}} יחד עם האישור הרפואי (מספר בקשה {{requestNumber}}).\n'
    + 'מועדי ההקפאה וההחזר ייקבעו לפי סעיף 8 בתנאי השימוש, ועדכון יופיע באפליקציה. החיוב החודשי לא משתנה; החזר, אם מגיע, מבוצע בנפרד.',
};

/** The texts Or saves. The medical two are optional: a save without them keeps what's stored (`current`). */
export function validateSettings(body: Record<string, unknown>, current: RequestSettings): { ok: true; value: RequestSettings } | { ok: false; error: string } {
  const text = (k: keyof RequestSettings) => (typeof body[k] === 'string' ? (body[k] as string).trim() : current[k]);
  const value: RequestSettings = {
    requestText: typeof body.requestText === 'string' ? body.requestText.trim() : '',
    confirmationText: typeof body.confirmationText === 'string' ? body.confirmationText.trim() : '',
    medicalRequestText: text('medicalRequestText'),
    medicalConfirmationText: text('medicalConfirmationText'),
  };
  const all = Object.values(value);
  if (all.some((t) => t.length < 5)) return { ok: false, error: 'text_required' };
  if (all.some((t) => t.length > MAX_TEMPLATE)) return { ok: false, error: 'text_too_long' };
  return { ok: true, value };
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** Short number the parent and Or can quote. */
export const requestNumberOf = (requestId: string) => requestId.replace(/-/g, '').slice(0, 8).toUpperCase();

// ─── Receipt integrity ──────────────────────────────────────────────────────

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 of the receipt's content, in a fixed key order, so any later change to it shows. */
export const receiptHash = (receipt: Record<string, unknown>) => createHash('sha256').update(canonical(receipt)).digest('hex');
