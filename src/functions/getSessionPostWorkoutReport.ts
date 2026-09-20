import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import { fetchSessionLookups, resolveSessionDetail } from '../lib/sessionDetail';
import { resolveSessionReportContext } from '../lib/sessionWorkoutReport';
import { resolveSessionWorkoutLogStatus } from '../lib/sessionWorkoutLogStatus';
import type { ClassItem } from '../lib/entities';

// GET or POST /getSessionPostWorkoutReport
// Query/body: { classId: string }
// Auth: Cognito JWT, staff only (coach with attendance:'write', or admin) —
// same gate as markActualAttendance.ts/closeSession.ts, since this is the
// coach's own end-of-session flow, not a trainee-facing one (contrast with
// getSessionWorkoutPlan.ts, which is the trainee's self-log read side).
//
// Single fetch backing PostWorkoutReportScreen.tsx's whole dynamic
// type-branch: returns which flavor of report this session needs
// (isTestSession/testGroupId → grading matrix via TestSessionGradingPanel;
// workoutPlanId → measurable-exercise roster checklist via
// workoutLogStatus/WorkoutLogGradingPanel, pre-filtered to ONLY the plan's
// מדידים blocks — non-measurable warm-up/cooldown content never appears
// here; neither → a "not assigned" note). There is no separate session-level
// report record any more — logging a station or a test attempt saves and
// stamps itself immediately (see logSessionExercise.ts / adminRecordTestAttempt.ts),
// so this endpoint is a pure read/resolver, nothing to submit back.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance !== 'write') return json(403, { error: 'forbidden' });

  let classId = event.queryStringParameters?.classId ?? '';
  if (!classId && event.body) {
    try {
      const body = JSON.parse(event.body) as { classId?: unknown };
      classId = typeof body.classId === 'string' ? body.classId : '';
    } catch { /* ignore */ }
  }
  if (!classId) return json(400, { error: 'missing_class_id' });

  const resolved = await resolveSessionReportContext(classId);
  if (!resolved.ok) return json(resolved.status, { error: resolved.error });
  const { session, workoutPlanId, workoutPlanName } = resolved;

  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });

  const classItem = session as ClassItem & { PK: string };
  const lookups = await fetchSessionLookups([classItem]);
  const detail = await resolveSessionDetail(classItem, lookups, access);

  const presentMemberIds = detail.roster.filter((r) => r.actualAttendance === 'present').map((r) => r.memberId);
  const workoutLogStatus = (detail.workoutPlanId && !detail.isTestSession && presentMemberIds.length > 0)
    ? await resolveSessionWorkoutLogStatus(classId, detail.workoutPlanId, presentMemberIds)
    : { sections: [], loggedByMember: {} };

  return json(200, {
    classId,
    className: session.className ?? '',
    date: session.date,
    workoutPlanId,
    workoutPlanName,
    isTestSession: detail.isTestSession,
    testGroupId: detail.testGroupId,
    testGroupName: detail.testGroupName,
    testComponentIds: detail.testComponentIds,
    // Unfiltered (present + absent + unmarked) — TestSessionGradingPanel
    // grades against the full roster, same as its existing
    // ForcaSessionDetailPanel usage; WorkoutLogGradingPanel filters this down
    // to actualAttendance==='present' itself (only an attended trainee has
    // anything to log).
    roster: detail.roster.map((r) => ({ memberId: r.memberId, name: r.name, actualAttendance: r.actualAttendance })),
    workoutLogStatus,
  });
}
