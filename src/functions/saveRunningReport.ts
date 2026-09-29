import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, RegistrationItem, RunningReportItem } from '../lib/entities';

// POST /saveRunningReport
// Body: { classId: string, perceivedExertion: number (1-10), averagePace: string, loggedAt?: string }
// Auth: Cognito JWT, any signed-in FORCA member — always writes for herself,
// same "only the trainee herself" convention as logSessionExercise.ts (RPE
// is inherently self-reported). Requires she's registered for a session
// flagged isRunningSession (see ClassItem/TrainingTypeItem.category in
// entities.ts) whose own scheduled end time (ClassItem.endDate) has
// passed — same self-report gate as resolveMeasurableSessionWorkout() in
// lib/sessionWorkout.ts (not duplicated as a shared helper since running
// sessions have no Workout Plan/station concept to resolve alongside it),
// deliberately NOT gated behind a coach marking actualAttendance first
// (see the FORCA Trainee Post-Workout Report scheduled-trigger spec).
// Deterministic PK (classId+uid) — a re-save overwrites the same summary
// rather than accumulating duplicate entries, see RunningReportItem in
// entities.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { classId?: unknown; perceivedExertion?: unknown; averagePace?: unknown; loggedAt?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });
  const perceivedExertion = typeof body.perceivedExertion === 'number' ? body.perceivedExertion : NaN;
  if (!Number.isInteger(perceivedExertion) || perceivedExertion < 1 || perceivedExertion > 10) {
    return json(400, { error: 'invalid_perceived_exertion' });
  }
  const averagePace = typeof body.averagePace === 'string' ? body.averagePace.trim() : '';
  if (!averagePace) return json(400, { error: 'missing_average_pace' });

  const [regRes, sessionRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: `REG#${callerUid}` } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
  ]);
  const registration = regRes.Item as RegistrationItem | undefined;
  if (!registration) return json(403, { error: 'not_registered' });
  const session = sessionRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!session.isRunningSession) return json(404, { error: 'not_a_running_session' });

  // Falls back to the session's own start (`date`) if endDate was never set
  // (a session created before that field existed) rather than blocking her
  // forever on a gate that can never pass.
  const endInstant = new Date(session.endDate ?? session.date).getTime();
  if (Number.isNaN(endInstant) || Date.now() < endInstant) {
    return json(403, { error: 'session_not_ended' });
  }

  const loggedAt = typeof body.loggedAt === 'string' && body.loggedAt ? body.loggedAt : new Date().toISOString();
  const nowIso = new Date().toISOString();

  const item: RunningReportItem = {
    PK: `RUNNINGREPORT#${classId}#${callerUid}`,
    SK: 'METADATA',
    GSI1PK: `MEMBER#${callerUid}`,
    GSI1SK: `RUNNINGREPORT#${loggedAt}#${classId}`,
    userId: callerUid,
    classId,
    perceivedExertion,
    averagePace,
    loggedAt,
    createdAt: nowIso,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true });
}
