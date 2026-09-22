import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ClassItem } from './entities';

export type ResolveSessionWorkoutReportResult =
  | {
      ok: true;
      session: ClassItem;
      workoutPlanId: string | null;
      workoutPlanName: string | null;
    }
  | { ok: false; status: number; error: string };

// Shared by getSessionPostWorkoutReport.ts (read) and
// saveSessionPostWorkoutReport.ts (write) — resolves the session and its
// assigned Workout Plan identity (if any). Staff-only: the caller's own
// access is checked by each endpoint (sessionInAccess), not here. Used to
// carry a plan-wide `sections`/block-completion checklist (every block,
// including non-measurable warm-up/cooldown ones) — removed per explicit
// ask to keep the coach's report scoped to measurable content only (see
// WorkoutLogGradingPanel.tsx / sessionWorkoutLogStatus.ts for that).
export async function resolveSessionReportContext(
  classId: string,
): Promise<ResolveSessionWorkoutReportResult> {
  const sessionRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
  const session = sessionRes.Item as ClassItem | undefined;
  if (!session) return { ok: false, status: 404, error: 'session_not_found' };

  return {
    ok: true,
    session,
    workoutPlanId: session.workoutPlanId ?? null,
    workoutPlanName: session.workoutPlanName ?? null,
  };
}
