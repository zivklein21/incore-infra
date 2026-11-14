import { roundMoney } from '../forcaRefunds/rules';

type FreezeHolder = { medicalFreezes?: { from: string; to: string }[] };

// FORCA medical freeze (section 8): the pure rules.
//
// - The parent's notice is a parent request (lib/forcaCancelRequests) of type
//   'medical_freeze', with a medical certificate that only Or can open.
// - The freeze starts by default on the day the notice and certificate were
//   received (Israel time): never retroactive. Or may start it earlier only
//   with a reason: hospitalization, accident or a sudden medical event.
// - Shorter than 14 consecutive days: a warning, not a block.
// - Refund per month = monthly payment x sessions cancelled by the freeze /
//   sessions scheduled in that month. Or can adjust it before approving.
//   Every credit is an immediate refund; the monthly charge never changes.
// - No session bank: frozen sessions are never kept for later.

export const MIN_FREEZE_DAYS = 14;
export const MAX_FREEZE_DAYS = 366;

export const START_REASONS = ['hospitalization', 'accident', 'sudden_medical_event'] as const;
export type StartReason = typeof START_REASONS[number];
export const START_REASON_LABEL: Record<StartReason, string> = {
  hospitalization: 'אשפוז',
  accident: 'תאונה',
  sudden_medical_event: 'אירוע רפואי פתאומי',
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v: unknown): v is string => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const pad = (n: number) => String(n).padStart(2, '0');
const dayOfUtc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOfUtc(d);
}

/** Inclusive length in days. */
export const lengthInDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export const monthOf = (day: string) => day.slice(0, 7);

/** Every "YYYY-MM" the range touches. */
export function monthsInRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

/** Every day of a month, "YYYY-MM-DD". */
export function daysOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${pad(i + 1)}`);
}

export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

export type FreezeDates = { from: string; to: string; startReason?: StartReason; startReasonNote?: string };
export type FreezeCheck =
  | { ok: true; value: FreezeDates; warnings: { code: string; message: string }[] }
  | { ok: false; error: string };

/**
 * Checks Or's freeze dates against the day the notice was received.
 * Earlier than that needs one of the three reasons and a note; later is fine.
 */
export function checkFreezeDates(raw: { from?: unknown; to?: unknown; startReason?: unknown; startReasonNote?: unknown }, receivedDay: string): FreezeCheck {
  if (!isDay(raw.from) || !isDay(raw.to)) return { ok: false, error: 'invalid_dates' };
  const { from, to } = raw;
  if (to < from) return { ok: false, error: 'end_before_start' };
  const days = lengthInDays(from, to);
  if (days > MAX_FREEZE_DAYS) return { ok: false, error: 'freeze_too_long' };

  const value: FreezeDates = { from, to };
  if (from < receivedDay) {
    if (!START_REASONS.includes(raw.startReason as StartReason)) return { ok: false, error: 'start_reason_required' };
    const note = typeof raw.startReasonNote === 'string' ? raw.startReasonNote.trim() : '';
    if (note.length < 2) return { ok: false, error: 'start_reason_note_required' };
    if (note.length > 500) return { ok: false, error: 'start_reason_note_too_long' };
    value.startReason = raw.startReason as StartReason;
    value.startReasonNote = note;
  }

  const warnings: { code: string; message: string }[] = [];
  if (days < MIN_FREEZE_DAYS) {
    warnings.push({ code: 'shorter_than_14_days', message: `ההקפאה קצרה מ-${MIN_FREEZE_DAYS} ימים רצופים (${days} ימים).` });
  }
  if (from < receivedDay) {
    warnings.push({ code: 'retroactive_start', message: `תחילת ההקפאה לפני יום קבלת ההודעה (${receivedDay.split('-').reverse().join('/')}): ${START_REASON_LABEL[value.startReason!]}.` });
  }
  return { ok: true, value, warnings };
}

/** The freeze's days inside one month. */
export function freezeDaysIn(month: string, from: string, to: string): { start: string; end: string } | null {
  const days = daysOfMonth(month);
  const start = from > days[0] ? from : days[0];
  const end = to < days[days.length - 1] ? to : days[days.length - 1];
  return start <= end ? { start, end } : null;
}

/** Section 8: monthly payment x sessions cancelled / sessions scheduled that month, rounded to agorot. */
export function refundForMonth(monthlyPayment: number, frozenSessions: number, totalSessions: number): number {
  if (!(monthlyPayment > 0) || !(totalSessions > 0) || !(frozenSessions > 0)) return 0;
  return roundMoney(monthlyPayment * Math.min(frozenSessions, totalSessions) / totalSessions);
}

/**
 * Sessions a group's recurring schedule would have on `days`, for a month
 * whose sessions don't exist yet (they're created a month at a time).
 */
export function projectedSessions(templates: { dayOfWeek: number[] }[], days: string[]): number {
  return days.reduce((sum, day) => sum + templates.filter((t) => t.dayOfWeek.includes(weekdayOf(day))).length, 0);
}

// ─── Certificate ────────────────────────────────────────────────────────────
// (Its retention date, which needs the archive's rule: retention.ts.)

export const CERTIFICATE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp',
};
export const MAX_CERTIFICATE_BYTES = 10 * 1024 * 1024;
export const CERTIFICATE_PREFIX = 'forca-medical-freeze/';
export const STAGING_PREFIX = 'forca-medical-freeze/staging/';
export const RETENTION_TAG = { Key: 'retention', Value: 'forca-medical-freeze' } as const;

/** The certificate's place: a random id only, never a member's uid (getFileUrl lets anyone whose uid is in a path read it). */
export const certificateKey = (requestId: string, contentType: string) => `${CERTIFICATE_PREFIX}${requestId}/certificate.${CERTIFICATE_TYPES[contentType] ?? 'bin'}`;
export const stagingKey = (uploadId: string) => `${STAGING_PREFIX}${uploadId}`;

/** "DD/MM/YYYY–DD/MM/YYYY" for the parent and the refund note. */
export const freezeRangeLabel = (from: string, to: string) => `${from.split('-').reverse().join('/')}–${to.split('-').reverse().join('/')}`;

// ─── Coaches ────────────────────────────────────────────────────────────────

/** "בהקפאה" on `day`: the freeze covering it, with dates only. */
export function freezeOn(profile: FreezeHolder | null | undefined, day: string): { from: string; to: string } | null {
  const f = (profile?.medicalFreezes ?? []).find((x) => x.from <= day && day <= x.to);
  return f ? { from: f.from, to: f.to } : null;
}

/** The freeze now or the next one, for the coach's trainee list. */
export function currentOrNextFreeze(profile: FreezeHolder | null | undefined, today: string): { from: string; to: string } | null {
  const f = (profile?.medicalFreezes ?? []).filter((x) => x.to >= today).sort((a, b) => a.from.localeCompare(b.from))[0];
  return f ? { from: f.from, to: f.to } : null;
}
