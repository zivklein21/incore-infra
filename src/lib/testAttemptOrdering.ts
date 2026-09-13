// Shared by adminGetTestAttempts.ts, getChildTestAttempts.ts, and
// adminRecordTestAttempt.ts — a test's displayed instance number and each
// component's changeVsPrevious arrow are both based on chronological (date)
// order, not recording order, so a backdated attempt (admin fixing a missed
// entry) slots in at the right spot instead of always landing last. The
// item's stored instanceNumber stays a simple write-time counter (for
// DynamoDB key uniqueness only) — this recomputes the *displayed* rank
// fresh every read.

interface ComponentResultLike {
  componentId: string;
  rawValue: number;
  higherIsBetter: boolean;
}

interface AttemptLike {
  date: string;
  instanceNumber: number;
  componentResults: ComponentResultLike[];
}

export type ChangeVsPrevious = 'up' | 'down' | 'same' | null;

export function changeVsPrevious(current: ComponentResultLike, prevResult: ComponentResultLike | null): ChangeVsPrevious {
  if (!prevResult) return null;
  if (current.rawValue === prevResult.rawValue) return 'same';
  return (current.higherIsBetter ? current.rawValue > prevResult.rawValue : current.rawValue < prevResult.rawValue) ? 'up' : 'down';
}

// Sorts by date ascending (instanceNumber as a same-date tiebreaker), then
// pairs each attempt with its 1-based display rank and its chronologically-
// previous attempt (for changeVsPrevious).
export function rankAttemptsByDate<T extends AttemptLike>(attempts: T[]): { attempt: T; rank: number; prev: T | null }[] {
  const sorted = [...attempts].sort((a, b) => a.date.localeCompare(b.date) || a.instanceNumber - b.instanceNumber);
  return sorted.map((attempt, i) => ({ attempt, rank: i + 1, prev: i > 0 ? sorted[i - 1] : null }));
}
