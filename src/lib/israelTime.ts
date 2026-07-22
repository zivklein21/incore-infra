// Asia/Jerusalem wall-clock helpers. Lambda containers always run in UTC
// regardless of an EventBridge rule's schedule expression — every comparison
// against a wall-clock hour/weekday must go through Intl.DateTimeFormat with
// an explicit timeZone, never Date's own getHours()/getDay().

export const ISRAEL_TZ = 'Asia/Jerusalem';

export function israelHour(d: Date): number {
  return parseInt(new Intl.DateTimeFormat('en', { timeZone: ISRAEL_TZ, hour: '2-digit', hour12: false }).format(d), 10);
}

export function israelMinute(d: Date): number {
  return parseInt(new Intl.DateTimeFormat('en', { timeZone: ISRAEL_TZ, minute: '2-digit' }).format(d), 10);
}

/** 0 (Sunday) – 6 (Saturday), matching Date.getDay()'s convention. */
export function israelWeekday(d: Date): number {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: ISRAEL_TZ, weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
}

/** "YYYY-MM-DD" of `d` in Asia/Jerusalem. */
export function israelDateStrOf(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: ISRAEL_TZ });
}

/** "YYYY-MM-DD" in Asia/Jerusalem, `offsetDays` from today. */
export function israelDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return israelDateStrOf(d);
}

/**
 * Converts a wall-clock date+hour in Asia/Jerusalem to a UTC Date.
 * Detects the DST offset by probing noon UTC on that day.
 */
export function israelHourToUTC(dateStr: string, hour: number, minute = 0): Date {
  const noonUtc = new Date(`${dateStr}T12:00:00Z`);
  const offsetHrs = israelHour(noonUtc) - 12;
  const utc = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  utc.setTime(utc.getTime() - offsetHrs * 3_600_000);
  return utc;
}
