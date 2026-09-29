import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, ExerciseLogEntryItem, RegistrationItem, RunningReportItem } from '../lib/entities';

// GET or POST /getMyAttendanceHistory
// Auth: Cognito JWT, any signed-in FORCA member — her own past training
// session attendance (declared vs. actual), newest first. FORCA-only; an
// INCORE caller simply has no REG#<uid> items in this table and gets an
// empty list back.
//
// Unlike getTrainingHistory.ts (admin, every session + every trainee's
// roster via resolveSessionDetail/CoachAccess), this only needs the
// caller's own registrations — a direct Scan for her REG#<uid> sort keys
// avoids pulling in the coach-scoping/equipment machinery entirely. Same
// accepted Scan tradeoff as getTrainingHistory.ts at this app's documented
// <=50-users-per-brand scale.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const regsRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'SK = :sk',
    ExpressionAttributeValues: { ':sk': `REG#${uid}` },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  if (registrations.length === 0) return json(200, { sessions: [] });

  // Whether she's already submitted a report for a given session — a
  // workout-plan session counts as reported once she's logged at least one
  // measurable station (ExerciseLogEntryItem.classId, stamped by
  // logSessionExercise.ts); a running session counts once her RPE/pace
  // report exists (RunningReportItem, saveRunningReport.ts). Both are
  // fetched once via her own GSI1 partition rather than per-session, same
  // "one query, not N" approach getMyExerciseHistory.ts's own history read
  // already uses.
  const [sessionResults, exerciseLogsRes, runningReportsRes] = await Promise.all([
    Promise.all(registrations.map((r) =>
      ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } })),
    )),
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
    .map((r, i) => {
      const session = sessionResults[i].Item as ClassItem | undefined;
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

  return json(200, { sessions });
}
