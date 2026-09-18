import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import { resolveSessionWorkoutReportSections } from '../lib/sessionWorkoutReport';
import type { PostWorkoutReportItem } from '../lib/entities';

// GET or POST /getSessionPostWorkoutReport
// Query/body: { classId: string }
// Auth: Cognito JWT, staff only (coach with attendance:'write', or admin) —
// same gate as markActualAttendance.ts/closeSession.ts, since this is the
// coach's own end-of-session flow, not a trainee-facing one (contrast with
// getSessionWorkoutPlan.ts, which is the trainee's self-log read side).
//
// Returns the dynamic section checklist for the session's assigned Workout
// Plan (see lib/sessionWorkoutReport.ts) plus any already-submitted report,
// so the screen can both render the form and pre-fill it on re-open/edit.
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

  const resolved = await resolveSessionWorkoutReportSections(classId);
  if (!resolved.ok) return json(resolved.status, { error: resolved.error });
  const { session, workoutPlanId, workoutPlanName, sections } = resolved;

  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });

  const reportRes = await ddb.send(new GetCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `CLASS#${classId}`, SK: 'POSTWORKOUTREPORT' },
  }));
  const existingReport = (reportRes.Item as PostWorkoutReportItem | undefined) ?? null;

  return json(200, {
    classId,
    className: session.className ?? '',
    date: session.date,
    workoutPlanId,
    workoutPlanName,
    sections,
    existingReport: existingReport && {
      overallRpe: existingReport.overallRpe,
      sections: existingReport.sections,
      generalNotes: existingReport.generalNotes,
      submittedBy: existingReport.submittedBy,
      submittedAt: existingReport.submittedAt,
    },
  });
}
