import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { createSessionInstance } from '../lib/sessionInstance';

// POST /createTrainingSession
// Body: { groupId: string, date: string (ISO 8601, carries the picked time
//         too), trainingTypeId: string, repeatWeekly?: boolean, seriesId?: string,
//         location?: string, coachId?: string, coachName?: string }
// Auth: Cognito JWT, caller must be admin
//
// coachId/coachName come from getCoachOptions.ts's merged coach+admin list
// and are stored as-is (denormalized) — see entities.ts's ClassItem comment
// for why this isn't resolved by id on read instead.
//
// trainingTypeId is now required (not just linked equipment) — the session's
// className is derived from it, not typed by the admin, and its equipment
// requirements become the coach's pack list (see getCoachSessions.ts /
// toggleSessionEquipment.ts). notes is set to the Group's name, same idea —
// the admin doesn't type a description either. repeatWeekly/seriesId mirror
// createClass.ts's weekly-series convention exactly (same field names,
// repeat_weekly/series_id, ad hoc/untyped on ClassItem) — the weekly
// expansion itself happens client-side (one call per occurrence), same as
// useCreateClass.ts does for INCORE. This is also the one-off path a
// RecurringSessionItem template's own generation uses under the hood — see
// lib/sessionInstance.ts's createSessionInstance(), shared by both.
//
// FORCA-only. Unlike createClass.ts, every current member of the group is
// auto-registered immediately — no capacity limit, no individual booking
// call (bypasses bookClass.ts entirely; a coach's/trainee's only relation
// to this is markActualAttendance.ts / declareAttendance.ts).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    groupId?: unknown; date?: unknown; trainingTypeId?: unknown; repeatWeekly?: unknown; seriesId?: unknown;
    location?: unknown; coachId?: unknown; coachName?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  if (!groupId) return json(400, { error: 'missing_group_id' });
  const dateStr = typeof body.date === 'string' ? body.date : '';
  const parsedDate = dateStr ? new Date(dateStr) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime())) return json(400, { error: 'invalid_date' });
  const trainingTypeId = typeof body.trainingTypeId === 'string' ? body.trainingTypeId.trim() : '';
  if (!trainingTypeId) return json(400, { error: 'missing_training_type_id' });
  const repeatWeekly = body.repeatWeekly === true;
  const seriesId = typeof body.seriesId === 'string' && body.seriesId ? body.seriesId : undefined;
  const location = typeof body.location === 'string' && body.location.trim() ? body.location.trim() : undefined;
  const coachId = typeof body.coachId === 'string' && body.coachId ? body.coachId : undefined;
  const coachName = typeof body.coachName === 'string' && body.coachName.trim() ? body.coachName.trim() : undefined;

  const result = await createSessionInstance({
    groupId, trainingTypeId, date: parsedDate, createdBy: callerUid,
    repeatWeekly, seriesId, location, coachId, coachName,
  });
  if (!result.ok) {
    const status = result.error === 'group_has_no_members' ? 400 : 404;
    return json(status, { error: result.error });
  }

  return json(200, { success: true, classId: result.classId, registeredCount: result.registeredCount });
}
