import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ClassItem, WorkoutPlanBlockItem } from './entities';

export interface PostWorkoutReportSection {
  sectionId: string;
  label: string;
}

export type ResolveSessionWorkoutReportResult =
  | {
      ok: true;
      session: ClassItem;
      workoutPlanId: string | null;
      workoutPlanName: string | null;
      /** Every section of the assigned plan, in order — unlike sessionWorkout.ts's resolveMeasurableSessionWorkout, not filtered to measurable 'stations' sections, since a completion checklist cares about the whole plan (including the mandatory closing section). Empty when the session has no assigned plan. */
      sections: PostWorkoutReportSection[];
    }
  | { ok: false; status: number; error: string };

// Shared by getSessionPostWorkoutReport.ts (read) and
// saveSessionPostWorkoutReport.ts (write) so the report's own section list
// always matches what the read side showed — same pairing convention as
// resolveMeasurableSessionWorkout()/getSessionWorkoutPlan.ts for the
// trainee-facing flow. Staff-only: the caller's own access is checked by
// each endpoint (sessionInAccess), not here.
export async function resolveSessionWorkoutReportSections(
  classId: string,
): Promise<ResolveSessionWorkoutReportResult> {
  const sessionRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } }));
  const session = sessionRes.Item as ClassItem | undefined;
  if (!session) return { ok: false, status: 404, error: 'session_not_found' };

  if (!session.workoutPlanId) {
    return { ok: true, session, workoutPlanId: null, workoutPlanName: null, sections: [] };
  }

  const blocksRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${session.workoutPlanId}`, ':prefix': 'BLOCK#' },
  }));
  const sections = ((blocksRes.Items ?? []) as (WorkoutPlanBlockItem & { PK: string; SK: string })[])
    .sort((a, b) => a.order - b.order)
    .map((b) => ({ sectionId: b.SK.replace('BLOCK#', ''), label: b.label }));

  return {
    ok: true,
    session,
    workoutPlanId: session.workoutPlanId,
    workoutPlanName: session.workoutPlanName ?? null,
    sections,
  };
}
