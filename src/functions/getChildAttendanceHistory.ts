import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { batchGetClasses, isPagedRequest, queryMemberRegistrations } from '../lib/memberRegistrations';
import { decodeRowCursor, windowRows } from '../lib/datePaging';

// GET or POST /getChildAttendanceHistory?childUid=xxx
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of getMyAttendanceHistory.ts
// — see the FORCA Child Switcher plan. Same GSI1 registration read
// (lib/memberRegistrations.ts), just authorized via the family link instead of "this
// is my own uid".
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const qs = event.queryStringParameters ?? {};
  const paged = isPagedRequest(qs);
  const cursor = paged && qs.cursor ? decodeRowCursor(qs.cursor) : null;
  if (paged && qs.cursor && !cursor) return json(400, { error: 'invalid_cursor' });

  const registrations = await queryMemberRegistrations(link.table, childUid);
  if (registrations.length === 0) return json(200, paged ? { sessions: [], nextCursor: null } : { sessions: [] });

  const sessionResults = await batchGetClasses(link.table, registrations.map((r) => r.classId));

  const nowIso = new Date().toISOString();
  const sessions = registrations
    .map((r) => {
      const session = sessionResults.get(r.classId);
      if (!session || session.date >= nowIso) return null;
      return {
        classId: r.classId,
        date: session.date,
        className: session.className ?? '',
        declaredAttendance: r.declaredAttendance ?? 'pending',
        declineReason: r.declineReason || null,
        actualAttendance: r.actualAttendance ?? null,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  if (!paged) return json(200, { sessions });
  const page = windowRows(sessions.map((x) => ({ ...x, id: x.classId })), cursor);
  return json(200, {
    sessions: page.items.map(({ id: _id, ...x }) => x),
    nextCursor: page.nextCursor,
    coveredFrom: page.coveredFrom,
  });
}
