// FORCA activity periods (Manage → Payments → Activity Periods / תקופות פעילות).
//
// A period is a named, inclusive range of Israel calendar days
// ("YYYY-MM-DD"). Periods have two jobs:
//   1. Charging: the daily FORCA charge job only charges on a day inside a
//      period. A subscription that falls due outside every period stays due
//      and is charged once, on the first day of the next period — never for
//      the months in between.
//   2. Exit points: the end of a period is offered as a cancellation end date
//      (currentPeriodEnd). It never blocks a cancellation.
// Before each period ends, parents with an active subscription get a notice
// that the next period continues unless they ask to stop (terms §5.4).
//
// Nothing about a subscription is stored from the periods: its real next
// charge day is worked out from its stored nextChargeDate whenever it's
// needed (effectiveChargeDay), so editing periods only ever moves future
// charges and needs no data fix. Everything here is pure — store.ts does IO.

export type ActivityPeriod = { id: string; name: string; start: string; end: string };

export type PeriodSettings = {
  periods: ActivityPeriod[];
  reminderDaysBefore: number;
  reminderTitle: string;
  reminderBody: string;
  version: number;
  updatedAt?: string;
  updatedBy?: string;
};

export const DEFAULT_REMINDER_DAYS = 25;
// Draft wording — pending legal review; the admin edits it on the screen.
export const DEFAULT_REMINDER_TITLE = 'תקופת הפעילות מסתיימת';
export const DEFAULT_REMINDER_BODY =
  'תקופת {{periodName}} מסתיימת ב-{{endDate}}. המנוי של {{childNames}} ימשיך אוטומטית לתקופה הבאה ({{nextPeriodName}}, החל מ-{{nextStartDate}}). אם תרצו להפסיק, אפשר לבקש זאת לפני סיום התקופה.';
export const REMINDER_VARIABLES = ['periodName', 'endDate', 'nextPeriodName', 'nextStartDate', 'childNames'] as const;

export const DEFAULT_SETTINGS: PeriodSettings = {
  periods: [],
  reminderDaysBefore: DEFAULT_REMINDER_DAYS,
  reminderTitle: DEFAULT_REMINDER_TITLE,
  reminderBody: DEFAULT_REMINDER_BODY,
  version: 0,
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in "YYYY-MM-DD" form. */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** `day` plus `n` calendar days (n may be negative). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The 1st of the month after `day`. */
export function firstOfNextMonthDay(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** "D/M" — how dates read in parent-facing Hebrew copy ("חוזרים ב-1/9"). */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${d}/${m}`;
}

/** "D/M/YYYY". */
export function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d}/${m}/${y}`;
}

export function sortPeriods(periods: ActivityPeriod[]): ActivityPeriod[] {
  return [...periods].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** The period `day` falls in, or null. */
export function periodOn(periods: ActivityPeriod[], day: string): ActivityPeriod | null {
  return periods.find((p) => p.start <= day && day <= p.end) ?? null;
}

/** The first period starting after `day`, or null. */
export function nextPeriodAfter(periods: ActivityPeriod[], day: string): ActivityPeriod | null {
  return sortPeriods(periods).find((p) => p.start > day) ?? null;
}

export const isChargeDay = (periods: ActivityPeriod[], day: string) => periodOn(periods, day) !== null;

/** `fromDay` if it's inside a period, else the start of the next period, else null (no more charges). */
export function nextChargeDay(periods: ActivityPeriod[], fromDay: string): string | null {
  if (isChargeDay(periods, fromDay)) return fromDay;
  return nextPeriodAfter(periods, fromDay)?.start ?? null;
}

/**
 * The day a subscription will really be charged next: its stored due day
 * (or today, if it's already due and waiting), moved to the first day
 * inside a period. null = no period ahead, so no charge is scheduled.
 */
export function effectiveChargeDay(periods: ActivityPeriod[], dueDay: string, today: string): string | null {
  return nextChargeDay(periods, dueDay > today ? dueDay : today);
}

/** Exit point: the end of the period `day` is in, or null between periods. */
export function currentPeriodEnd(periods: ActivityPeriod[], day: string): string | null {
  return periodOn(periods, day)?.end ?? null;
}

export type ActivityStatus = {
  inPeriod: boolean;
  currentPeriod: ActivityPeriod | null;
  nextPeriod: ActivityPeriod | null;
  /** Hebrew label for "between periods", e.g. "אין פעילות – חוזרים ב-1/9"; null inside a period. */
  offLabel: string | null;
};

export function activityStatus(periods: ActivityPeriod[], today: string): ActivityStatus {
  const currentPeriod = periodOn(periods, today);
  const nextPeriod = nextPeriodAfter(periods, today);
  return {
    inPeriod: currentPeriod !== null,
    currentPeriod,
    nextPeriod,
    offLabel: currentPeriod ? null : offPeriodLabel(nextPeriod?.start ?? null),
  };
}

export function offPeriodLabel(nextStart: string | null): string {
  return nextStart ? `אין פעילות – חוזרים ב-${shortDay(nextStart)}` : 'אין פעילות';
}

// ── Validation ──────────────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

export const MAX_PERIODS = 60;

export function validatePeriods(input: unknown, newId: () => string): Validated<ActivityPeriod[]> {
  if (!Array.isArray(input)) return { ok: false, error: 'periods_required' };
  if (input.length > MAX_PERIODS) return { ok: false, error: 'too_many_periods' };
  const out: ActivityPeriod[] = [];
  const ids = new Set<string>();
  for (const raw of input) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > 60) return { ok: false, error: 'invalid_name' };
    if (!isDay(r.start) || !isDay(r.end)) return { ok: false, error: 'invalid_date', detail: name };
    if (r.start > r.end) return { ok: false, error: 'start_after_end', detail: name };
    let id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    out.push({ id, name, start: r.start, end: r.end });
  }
  const sorted = sortPeriods(out);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) {
      return { ok: false, error: 'periods_overlap', detail: `${sorted[i - 1].name} / ${sorted[i].name}` };
    }
  }
  return { ok: true, value: sorted };
}

export type ReminderSettings = Pick<PeriodSettings, 'reminderDaysBefore' | 'reminderTitle' | 'reminderBody'>;

export function validateReminder(input: Record<string, unknown>, current: ReminderSettings): Validated<ReminderSettings> {
  const days = input.reminderDaysBefore === undefined ? current.reminderDaysBefore : Number(input.reminderDaysBefore);
  if (!Number.isInteger(days) || days < 1 || days > 90) return { ok: false, error: 'invalid_reminder_days' };
  const title = input.reminderTitle === undefined ? current.reminderTitle : String(input.reminderTitle).trim();
  const body = input.reminderBody === undefined ? current.reminderBody : String(input.reminderBody).trim();
  if (!title || title.length > 80) return { ok: false, error: 'invalid_reminder_title' };
  if (!body || body.length > 1000) return { ok: false, error: 'invalid_reminder_body' };
  return { ok: true, value: { reminderDaysBefore: days, reminderTitle: title, reminderBody: body } };
}

// ── Reminder ────────────────────────────────────────────────────────────────

/**
 * Periods whose notice window is open on `today`: from `daysBefore` days
 * before the end up to the end itself. A window (not one exact day) so a
 * missed run or a later change of daysBefore still sends — the per-parent
 * marker keeps it to once per period. Only periods with a next period: the
 * notice promises one, so without it nothing is sent.
 */
export function periodsDueForReminder(periods: ActivityPeriod[], today: string, daysBefore: number): { period: ActivityPeriod; next: ActivityPeriod }[] {
  const due: { period: ActivityPeriod; next: ActivityPeriod }[] = [];
  for (const period of sortPeriods(periods)) {
    if (today < addDays(period.end, -daysBefore) || today > period.end) continue;
    const next = nextPeriodAfter(periods, period.end);
    if (next) due.push({ period, next });
  }
  return due;
}

/** Periods (current or future) with no period after them — the screen warns that their notice won't go out. */
export function periodsWithoutNext(periods: ActivityPeriod[], today: string): ActivityPeriod[] {
  return sortPeriods(periods).filter((p) => p.end >= today && !nextPeriodAfter(periods, p.end));
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}

export function reminderVars(period: ActivityPeriod, next: ActivityPeriod, childNames: string[]): Record<string, string> {
  return {
    periodName: period.name,
    endDate: longDay(period.end),
    nextPeriodName: next.name,
    nextStartDate: longDay(next.start),
    childNames: childNames.filter(Boolean).join(', ') || 'ילדתך',
  };
}

// ── Preview (what a save changes) ──────────────────────────────────────────

export type PreviewAgreement = {
  agreementId: string;
  dueDay: string; // the stored nextChargeDate as an Israel day
  amount: number;
  childName: string;
  payerName: string;
  productName: string;
};

export type ChargeChange = {
  agreementId: string; childName: string; payerName: string; productName: string; amount: number;
  before: string | null; after: string | null;
};

export type MonthTotals = { month: string; beforeCount: number; beforeTotal: number; afterCount: number; afterTotal: number };

/** Each charge day over the next `months` calendar months, for one agreement (charge, then the 1st of the next month, moved into a period). */
export function simulateChargeDays(periods: ActivityPeriod[], dueDay: string, today: string, horizonEnd: string): string[] {
  const days: string[] = [];
  let day = effectiveChargeDay(periods, dueDay, today);
  while (day && day <= horizonEnd && days.length < 400) {
    days.push(day);
    day = nextChargeDay(periods, firstOfNextMonthDay(day));
  }
  return days;
}

export function monthKeys(today: string, months: number): string[] {
  const keys: string[] = [];
  let day = `${today.slice(0, 7)}-01`;
  for (let i = 0; i < months; i++) { keys.push(day.slice(0, 7)); day = firstOfNextMonthDay(day); }
  return keys;
}

export function previewPeriodChange(
  before: ActivityPeriod[], after: ActivityPeriod[], agreements: PreviewAgreement[], today: string, months = 12,
): { changes: ChargeChange[]; months: MonthTotals[] } {
  const keys = monthKeys(today, months);
  const horizonEnd = addDays(firstOfNextMonthDay(`${keys[keys.length - 1]}-01`), -1);
  const totals = new Map<string, MonthTotals>(keys.map((month) => [month, { month, beforeCount: 0, beforeTotal: 0, afterCount: 0, afterTotal: 0 }]));
  const changes: ChargeChange[] = [];
  for (const a of agreements) {
    const b = effectiveChargeDay(before, a.dueDay, today);
    const n = effectiveChargeDay(after, a.dueDay, today);
    if (b !== n) {
      changes.push({ agreementId: a.agreementId, childName: a.childName, payerName: a.payerName, productName: a.productName, amount: a.amount, before: b, after: n });
    }
    for (const day of simulateChargeDays(before, a.dueDay, today, horizonEnd)) {
      const t = totals.get(day.slice(0, 7)); if (t) { t.beforeCount++; t.beforeTotal += a.amount; }
    }
    for (const day of simulateChargeDays(after, a.dueDay, today, horizonEnd)) {
      const t = totals.get(day.slice(0, 7)); if (t) { t.afterCount++; t.afterTotal += a.amount; }
    }
  }
  changes.sort((x, y) => (x.after ?? '9999').localeCompare(y.after ?? '9999') || x.childName.localeCompare(y.childName));
  return { changes, months: Array.from(totals.values()) };
}
