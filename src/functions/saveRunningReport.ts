import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, RegistrationItem, RunningReportItem } from '../lib/entities';

// POST /saveRunningReport
// Body: { classId: string, perceivedExertion: number (1-10), averagePace: string, loggedAt?: string }
// Auth: Cognito JWT, any signed-in FORCA member — always writes for herself,
// same "only the trainee herself" convention as logSessionExercise.ts (RPE
// is inherently self-reported). Requires she was marked actually present
// for a session flagged isRunningSession (see ClassItem/TrainingTypeItem.category
// in entities.ts) — same attendance gate as resolveMeasurableSessionWorkout()
// in lib/sessionWorkout.ts, not duplicated here since running sessions have
// no Workout Plan/station concept to resolve alongside it.
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
  if (!registration || registration.actualAttendance !== 'present') {
    return json(403, { error: 'not_attended' });
  }
  const session = sessionRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!session.isRunningSession) return json(404, { error: 'not_a_running_session' });

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
