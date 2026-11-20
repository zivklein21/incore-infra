import { addDays, monthsInRange } from '../forcaMedicalFreeze/rules';
import { monthSessions } from '../forcaMedicalFreeze/store';
import { suggestRefund, type Suggestion } from './rules';
import { loadPricePerSession } from './store';

// Option ב's refund hint: the group's sessions after the legal date D up to
// the end of what was paid for (paidThroughDay), × price per session. The
// same partial-refund suggestion, over a different window. A month whose
// sessions aren't created yet is counted from the recurring schedule
// (estimated). A hint only: Or sets the amount, nothing is refunded by itself.

export type SuggestionBetween = Suggestion & { groupId: string | null; fromDay: string; toDay: string; estimated: boolean };

export async function buildSuggestionAfter(groupId: string | null, legalDay: string, paidThroughDay: string | null): Promise<SuggestionBetween> {
  const fromDay = addDays(legalDay, 1);
  const toDay = paidThroughDay ?? legalDay;
  const price = await loadPricePerSession();
  if (!groupId || toDay < fromDay) return { ...suggestRefund(0, price), groupId, fromDay, toDay, estimated: false };
  const months = await Promise.all(monthsInRange(fromDay, toDay).map((m) => monthSessions(groupId, m, fromDay, toDay)));
  const sessions = months.reduce((n, m) => n + m.frozen, 0);
  return { ...suggestRefund(sessions, price), groupId, fromDay, toDay, estimated: months.some((m) => m.estimated) };
}

/** "3 אימונים אחרי 10/02/2027 עד 28/02/2027 × ₪62.5" */
export function suggestionAfterLabel(s: SuggestionBetween): string {
  const f = (d: string) => d.split('-').reverse().join('/');
  return `${s.sessions} אימונים מ-${f(s.fromDay)} עד ${f(s.toDay)} × ₪${s.pricePerSession}${s.estimated ? ' (הערכה לפי מערכת השעות)' : ''}`;
}
