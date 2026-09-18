import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import { resolveStaffIdentity } from '../lib/staffIdentity';
import { resolveSessionWorkoutReportSections } from '../lib/sessionWorkoutReport';
import type { PostWorkoutReportItem } from '../lib/entities';

// POST /saveSessionPostWorkoutReport
// Body: { classId: string, overallRpe?: number, sections: { sectionId, completed, note? }[], generalNotes?: string }
// Auth: Cognito JWT, staff only — same gate as getSessionPostWorkoutReport.ts.
//
// Upserts one PostWorkoutReportItem per session (Put, not versioned — a
// re-submit overwrites the prior report in place, same "close the loop"
// convention as the rest of this endpoint pair). Section labels are always
// re-resolved server-side from the session's current Workout Plan rather
// than trusted from the client, so a stale/tampered label can never be
// stored — only which sectionIds the caller marked completed, and their
// notes, come from the request body.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance !== 'write') return json(403, { error: 'forbidden' });

  let body: {
    classId?: unknown;
    overallRpe?: unknown;
    sections?: unknown;
    generalNotes?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const overallRpe = typeof body.overallRpe === 'number' && body.overallRpe >= 1 && body.overallRpe <= 10
    ? body.overallRpe : null;
  const generalNotes = typeof body.generalNotes === 'string' ? body.generalNotes.trim() : '';

  const completedBySectionId = new Map<string, { completed: boolean; note: string }>();
  if (Array.isArray(body.sections)) {
    for (const entry of body.sections) {
      if (!entry || typeof entry !== 'object') continue;
      const sectionId = typeof (entry as any).sectionId === 'string' ? (entry as any).sectionId : '';
      if (!sectionId) continue;
      completedBySectionId.set(sectionId, {
        completed: (entry as any).completed === true,
        note: typeof (entry as any).note === 'string' ? (entry as any).note.trim() : '',
      });
    }
  }

  const resolved = await resolveSessionWorkoutReportSections(classId);
  if (!resolved.ok) return json(resolved.status, { error: resolved.error });
  const { session, workoutPlanId, workoutPlanName, sections: planSections } = resolved;

  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });

  const sections = planSections.map((s) => ({
    sectionId: s.sectionId,
    label: s.label,
    completed: completedBySectionId.get(s.sectionId)?.completed ?? false,
    note: completedBySectionId.get(s.sectionId)?.note ?? '',
  }));

  const submittedBy = await resolveStaffIdentity(callerUid, access);
  const submittedAt = new Date().toISOString();

  const report: PostWorkoutReportItem = {
    PK: `CLASS#${classId}`,
    SK: 'POSTWORKOUTREPORT',
    workoutPlanId,
    workoutPlanName,
    overallRpe,
    sections,
    generalNotes,
    submittedBy,
    submittedAt,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: report }));

  return json(200, {
    success: true,
    report: { overallRpe, sections, generalNotes, submittedBy, submittedAt },
  });
}
