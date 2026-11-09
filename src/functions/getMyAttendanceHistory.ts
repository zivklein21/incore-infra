import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ExerciseLogEntryItem, RunningReportItem } from '../lib/entities';
import { batchGetClasses, isPagedRequest, queryMemberRegistrations } from '../lib/memberRegistrations';
import { decodeRowCursor, windowRows } from '../lib/datePaging';

// GET or POST /getMyAttendanceHistory
// Auth: Cognito JWT, any signed-in FORCA member — her own past training
// session attendance (declared vs. actual), newest first. FORCA-only; an
// INCORE caller simply has no REG#<uid> items in this table and gets an
// empty list back.
//
// Unlike getTrainingHistory.ts (admin, every session + every trainee's
// roster via resolveSessionDetail/CoachAccess), this only needs the
// caller's own registrations — her registrations off her own GSI1 partition
// (lib/memberRegistrations.ts) avoid pulling in the coach-scoping/equipment machinery entirely. Same
// accepted Scan tradeoff as getTrainingHistory.ts at this app's documented
// <=50-users-per-brand scale.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const qs = event.queryStringParameters ?? {};
  const paged = isPagedRequest(qs);
  const cursor = paged && qs.cursor ? decodeRowCursor(qs.cursor) : null;
  if (paged && qs.cursor && !cursor) return json(400, { error: 'invalid_cursor' });

  const registrations = await queryMemberRegistrations(FORCA_TABLE_NAME, uid);
  if (registrations.length === 0) return json(200, paged ? { sessions: [], nextCursor: null } : { sessions: [] });

  // Whether she's already submitted a report for a given session — a
  // workout-plan session counts as reported once she's logged at least one
  // measurable station (ExerciseLogEntryItem.classId, stamped by
  // logSessionExercise.ts); a running session counts once her RPE/pace
  // report exists (RunningReportItem, saveRunningReport.ts). Both are
  // fetched once via her own GSI1 partition rather than per-session, same
  // "one query, not N" approach getMyExerciseHistory.ts's own history read
  // already uses.
  const [sessionResults, exerciseLogsRes, runningReportsRes] = await Promise.all([
    batchGetClasses(FORCA_TABLE_NAME, registrations.map((r) => r.classId)),
    ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'EXERCISELOG#' },
    })),
    ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'RUNNINGREPORT#' },
    })),
  ]);
  const exerciseLoggedClassIds = new Set(((exerciseLogsRes.Items ?? []) as ExerciseLogEntryItem[]).map((e) => e.classId));
  const runningReportedClassIds = new Set(((runningReportsRes.Items ?? []) as RunningReportItem[]).map((r) => r.classId));

  const nowIso = new Date().toISOString();
  const sessions = registrations
    .map((r) => {
      const session = sessionResults.get(r.classId);
      if (!session || session.date >= nowIso) return null;
      const isRunningSession = session.isRunningSession ?? false;
      const hasReported = isRunningSession
        ? runningReportedClassIds.has(r.classId)
        : !!session.workoutPlanId && exerciseLoggedClassIds.has(r.classId);
      return {
        classId: r.classId,
        date: session.date,
        // Scheduled end instant — lets the client gate "can she self-report
        // yet" on the session actually being OVER, not just started (see
        // resolveMeasurableSessionWorkout()/saveRunningReport.ts's own
        // self-report gate, which this mirrors client-side). null for a
        // session created before ClassItem.endDate existed; the client
        // falls back to `date` the same way the backend gate does.
        endDate: session.endDate ?? null,
        className: session.className ?? '',
        declaredAttendance: r.declaredAttendance ?? 'pending',
        declineReason: r.declineReason || null,
        actualAttendance: r.actualAttendance ?? null,
        workoutPlanId: session.workoutPlanId ?? null,
        isRunningSession,
        hasReported,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  if (!paged) return json(200, { sessions });
  // Last 2 months first, then 2 months per Load more (lib/datePaging.ts).
  const page = windowRows(sessions.map((x) => ({ ...x, id: x.classId })), cursor);
  return json(200, {
    sessions: page.items.map(({ id: _id, ...x }) => x),
    nextCursor: page.nextCursor,
    coveredFrom: page.coveredFrom,
  });
}
