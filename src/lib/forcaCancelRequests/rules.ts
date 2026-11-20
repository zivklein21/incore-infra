import { createHash } from 'crypto';
import { israelDateStrOf, ISRAEL_TZ } from '../israelTime';
import { addDays, isDay, nextPeriodAfter, periodOn, type ActivityPeriod } from '../forcaPeriods/rules';

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
  // What happens next depends on the parent's choice: that paragraph is
  // added after this text (choiceConfirmationLine), in fixed wording.
  confirmationText: 'בקשתך לביטול ההשתתפות של {{childName}} התקבלה ב-{{receivedAt}} (מספר בקשה {{requestNumber}}).',
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

// ─── The parent's choice (lawyer's update, 2026-11-20) ─────────────────────
//
// On a cancellation request the parent picks one of three, or nothing:
//   end_of_paid_month  א. active until the end of the paid month, no refund
//                      for it, no charge for the next. On submit the stop is
//                      scheduled by itself for the 1st of next month (the
//                      only thing that ever happens without Or).
//   early_legal        ב. early cancellation by law: Or sets the legal date,
//                      access ends that day, refund suggested for after it.
//   unsure             ג. the default: Or reviews; section 5.8 only as a hint.
// A request without a choice (older app, older records, nothing picked)
// behaves as ג. The wording is fixed (the lawyer's), not one of Or's texts.

export const PARENT_CHOICES = ['end_of_paid_month', 'early_legal', 'unsure'] as const;
export type ParentChoice = typeof PARENT_CHOICES[number];
/** 'parent' = she picked it; 'default' = nothing picked (ג); 'admin' = Or recorded it on a manual entry. */
export type ChoiceSource = 'parent' | 'default' | 'admin';

export const CHOICE_LABEL: Record<ParentChoice, string> = {
  end_of_paid_month: 'סיום בתום החודש ששולם',
  early_legal: 'בקשה לביטול מוקדם לפי דין',
  unsure: 'לא בטוח/ה – אשמח לבירור',
};

/** The line under each option in the parent's sheet. */
export const CHOICE_EXPLAIN: Record<ParentChoice, string> = {
  end_of_paid_month: 'ההשתתפות נמשכת עד סוף החודש ששולם. אין החזר על חודש זה, ולא יבוצע חיוב לחודש הבא.',
  early_legal: 'הבקשה נרשמת ומועברת לבדיקה: מועד הביטול לפי דין, הפסקת החיובים והחזר אם נדרש.',
  unsure: 'הבקשה נרשמת, ונחזור אלייך לבירור.',
};

/** The choice in a request body: missing → ג by default; anything unknown → null (400). */
export function parseChoice(raw: unknown): { choice: ParentChoice; source: ChoiceSource } | null {
  if (raw === undefined || raw === null || raw === '') return { choice: 'unsure', source: 'default' };
  return PARENT_CHOICES.includes(raw as ParentChoice) ? { choice: raw as ParentChoice, source: 'parent' } : null;
}

/** What a stored request counts as: no choice (older records) = ג. Medical freezes have none. */
export const choiceOf = (r: { type?: RequestType; choice?: ParentChoice | null }): ParentChoice | null =>
  ((r.type ?? 'cancellation') === 'cancellation' ? r.choice ?? 'unsure' : null);

/** Added to the request text the parent submits. */
export const choiceRequestLine = (choice: ParentChoice) => `בחירתי: ${CHOICE_LABEL[choice]}.`;

/**
 * Added to the confirmation. For א with the stop set: the last active day.
 * Without it (the automatic stop couldn't be set) no date is promised.
 */
export function choiceConfirmationLine(choice: ParentChoice, lastActiveDay: string | null): string {
  switch (choice) {
    case 'end_of_paid_month':
      return lastActiveDay
        ? `בחרת: ${CHOICE_LABEL[choice]}. ההשתתפות פעילה עד ${formatDay(lastActiveDay)}, ולא יבוצע חיוב לחודש הבא. אין החזר על החודש הנוכחי.`
        : `בחרת: ${CHOICE_LABEL[choice]}. מועד הסיום ייקבע ויופיע באפליקציה. אין החזר על החודש הנוכחי, ולא יבוצע חיוב לחודש הבא.`;
    case 'early_legal':
      return `בחרת: ${CHOICE_LABEL[choice]}. הבקשה הועברה לבדיקה: מועד הביטול לפי דין, הפסקת החיובים וההחזר (אם נדרש) ייקבעו לפי הדין, ועדכון יופיע באפליקציה.`;
    default:
      return `בחרת: ${CHOICE_LABEL[choice]}. נחזור אלייך לבירור, ועדכון יופיע באפליקציה.`;
  }
}

export const EARLY_LEGAL_FLAG = 'ביטול מוקדם לפי דין – נדרשת בדיקה';
export const AUTO_STOP_REASON = 'נקבע אוטומטית לפי בחירת ההורה (סעיף 5.8)';

/** How the cancel sheet treats section 5.8's date for this request. */
export type SuggestionUse = 'preselect' | 'hint' | 'none';
export function suggestionUseFor(choice: ParentChoice | null): SuggestionUse {
  if (choice === 'early_legal') return 'none';
  if (choice === 'end_of_paid_month') return 'preselect';
  return 'hint';
}

/** Open early-cancellation requests first, then newest received first. */
export function sortForOr<T extends { status: RequestStatus; receivedAt: string; type?: RequestType; choice?: ParentChoice | null }>(rows: T[]): T[] {
  const urgent = (r: T) => (r.status !== 'done' && choiceOf(r) === 'early_legal' ? 0 : 1);
  return [...rows].sort((a, b) => urgent(a) - urgent(b) || b.receivedAt.localeCompare(a.receivedAt));
}

// ─── Option א: the automatic stop ──────────────────────────────────────────

export type AutoStopSkipReason = 'no_subscription' | 'not_active' | 'existing_stop' | 'periods_unreadable' | 'stop_refused' | 'conflict' | 'error';

/** What happened to the automatic stop, kept on the request for Or. */
export type AutoStopOutcome =
  | { result: 'scheduled'; stopDay: string; lastActiveDay: string; agreementId: string }
  | { result: 'skipped'; reason: AutoStopSkipReason; message: string; highlight: boolean; existingStopDay?: string; detail?: string };

const SKIP_MESSAGE: Record<Exclude<AutoStopSkipReason, 'existing_stop'>, string> = {
  no_subscription: 'לא נקבעה עצירה אוטומטית: לא נמצא מנוי',
  not_active: 'לא נקבעה עצירה אוטומטית: המנוי אינו פעיל',
  periods_unreadable: 'לא נקבעה עצירה אוטומטית: לא ניתן לקרוא את תקופות הפעילות',
  stop_refused: 'לא נקבעה עצירה אוטומטית: מועד העצירה נדחה',
  conflict: 'לא נקבעה עצירה אוטומטית: המנוי השתנה באותו רגע',
  error: 'לא נקבעה עצירה אוטומטית: תקלה',
};

export function autoStopSkipped(reason: Exclude<AutoStopSkipReason, 'existing_stop'>, detail?: string): AutoStopOutcome {
  return { result: 'skipped', reason, message: SKIP_MESSAGE[reason], highlight: true, ...(detail ? { detail } : {}) };
}

const shortDayLabel = (day: string) => { const [, m, d] = day.split('-'); return `${d}/${m}`; };

/**
 * A stop already exists: nothing changes by itself. Later than the parent's
 * end → highlighted for Or to check; earlier or the same → a note.
 */
export function existingStopOutcome(existingStopDay: string, parentStopDay: string, parentLastActiveDay: string): AutoStopOutcome {
  const later = existingStopDay > parentStopDay;
  return {
    result: 'skipped', reason: 'existing_stop', existingStopDay, highlight: later,
    message: later
      ? `ההורה בחר/ה לסיים ב-${shortDayLabel(parentLastActiveDay)} – קיימת עצירה מאוחרת יותר, לבדוק`
      : `קיימת כבר עצירה ב-${formatDay(existingStopDay)} (מוקדמת או זהה לבחירת ההורה) – לא נקבעה עצירה נוספת`,
  };
}

// ─── Option ב: the legal effective date ────────────────────────────────────

/**
 * Or's legal date D → the stop. Charges stop and access ends at D:
 * D today or earlier → stop now; D later → stop day D+1 (nothing charged from then).
 */
export function legalDateToStop(day: unknown, receivedDay: string, today: string):
  { ok: true; legalDay: string; mode: 'now' | 'date'; stopDay: string } | { ok: false; error: string } {
  if (!isDay(day)) return { ok: false, error: 'invalid_legal_day' };
  if (day < receivedDay) return { ok: false, error: 'legal_day_before_receipt' };
  if (day > addDays(today, 730)) return { ok: false, error: 'legal_day_too_far' };
  return day <= today ? { ok: true, legalDay: day, mode: 'now', stopDay: today } : { ok: true, legalDay: day, mode: 'date', stopDay: addDays(day, 1) };
}

// ─── Distance sale (sections 14ג, 14ה) ─────────────────────────────────────

export const DISTANCE_SALE_WARNING = 'בקשה סמוכה להרשמה – לבדוק ביטול עסקת מכר מרחוק (סעיפים 14ג, 14ה)';
export const DISTANCE_SALE_DAYS = 14;
export type DistanceSaleReason = 'no_payment' | 'within_14_days' | 'before_service_start';
export type DistanceSale = { warn: boolean; reasons: DistanceSaleReason[]; firstPaymentDay: string | null; serviceStartDay: string | null; message: string | null };

/**
 * Warns Or when a request came in within 14 days of the child's first FORCA
 * payment (Israel days, the payment day + 14 still counts), or before the
 * service started: the first activity-period day on or after that payment
 * (a sign-up before the season). No payment found also warns.
 */
export function distanceSaleCheck(receivedAt: string, firstPaymentAt: string | null, periods: ActivityPeriod[]): DistanceSale {
  const receivedDay = israelDateStrOf(new Date(receivedAt));
  if (!firstPaymentAt) {
    return { warn: true, reasons: ['no_payment'], firstPaymentDay: null, serviceStartDay: null, message: `${DISTANCE_SALE_WARNING} · לא נמצא תשלום FORCA` };
  }
  const firstPaymentDay = israelDateStrOf(new Date(firstPaymentAt));
  const serviceStartDay = periodOn(periods, firstPaymentDay) ? firstPaymentDay : nextPeriodAfter(periods, firstPaymentDay)?.start ?? firstPaymentDay;
  const reasons: DistanceSaleReason[] = [];
  if (receivedDay <= addDays(firstPaymentDay, DISTANCE_SALE_DAYS)) reasons.push('within_14_days');
  if (receivedDay < serviceStartDay) reasons.push('before_service_start');
  return { warn: reasons.length > 0, reasons, firstPaymentDay, serviceStartDay, message: reasons.length ? DISTANCE_SALE_WARNING : null };
}

/** The earliest completed charge, or null. */
export function firstPaymentOf(charges: ChargeLike[]): string | null {
  const done = charges.filter((c) => (c.status ?? 'completed') === 'completed').map((c) => c.createdAt).sort();
  return done[0] ?? null;
}
