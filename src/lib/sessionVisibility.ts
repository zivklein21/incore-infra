import { israelDateStr } from './entities';

/**
 * Whether a trainee/parent "upcoming sessions" list should still show this
 * session. It used to be `date >= now`, so a session vanished the moment
 * it STARTED — a session the admin added for today at a time that had
 * already passed, or one in progress, never appeared on the trainee's
 * Home ("האימון שלך היום"). Now: any session from today (Israel calendar)
 * onward, until its scheduled end (endDate) has passed. With no endDate it
 * stays for the rest of its day.
 */
export function isStillUpcomingForTrainee(s: { date: string; endDate?: string | null }, now: number = Date.now()): boolean {
  const start = new Date(s.date);
  if (Number.isNaN(start.getTime())) return false;
  if (israelDateStr(start) < israelDateStr(new Date(now))) return false;
  if (s.endDate) {
    const end = new Date(s.endDate).getTime();
    if (!Number.isNaN(end) && end < now) return false;
  }
  return true;
}
