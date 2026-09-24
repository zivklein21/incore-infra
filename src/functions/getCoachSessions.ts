import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import { fetchSessionLookups, resolveSessionDetail } from '../lib/sessionDetail';
import { israelDateStrRange } from '../lib/sessionInstance';
import type { ClassItem } from '../lib/entities';

// GET or POST /getCoachSessions
// Auth: Cognito JWT, caller must be a coach (attendance permission != 'none')
// or admin (see getCoachAccess.ts) — results are scoped to sessions actually
// assigned to her (both her group AND her coachId — see sessionInAccess()),
// not every session in a group she happens to share with other coaches. An
// admin sees everything, unrestricted. medicalFlag is stripped when she has
// no healthDeclarations permission.
//
// Lists FORCA training sessions (a ClassItem with a groupId — see
// createTrainingSession.ts) with their full roster and equipment pack list
// — see lib/sessionDetail.ts's resolveSessionDetail() for the shared
// computation (also reused by getTrainingHistory.ts, which filters to only
// past sessions and adds a declared-vs-actual discrepancy check per roster
// entry). This is also what the FORCA admin Home dashboard reuses (via
// useCoachSessions(), filtered/sorted client-side) — no separate endpoint.
// View-only except for markActualAttendance.ts / toggleSessionEquipment.ts /
// returnSessionEquipment.ts.
//
// Query/body: { from?: string, to?: string } (ISO 8601 dates, `to`
// exclusive). Fetched via a per-day Query against the existing GSI2
// CLASSDATE# index (same one adminAddToClass.ts/adminGenerateMonthInstances.ts
// already use for same-day lookups) rather than a table Scan — a Scan reads
// every item in the ENTIRE table (every entity type, not just sessions)
// before any FilterExpression is applied, so a plain date *filter* on a Scan
// doesn't actually reduce its cost; only a real per-day Query does. This
// replaced exactly that Scan-with-date-filter, which still kept the
// client's 6s NETWORK_TIMEOUT firing as the table grew even after the
// filter was added. Omitting from/to defaults to a tight window matched to
// what the Home dashboards actually read (ForcaAdminHomeScreen.tsx /
// ForcaCoachHomeScreen.tsx only ever look 30 minutes into the past — to
// still offer closing an overdue session — and 7 days into the future for
// their weekly list; the 2/14-day default below pads that slightly rather
// than matching it exactly). Deliberately NOT a generous multi-month
// window: every extra day here is another parallel GSI2 Query plus another
// session run through the roster-resolving fan-out below, so padding
// "just in case" directly undoes the point of this fix.
// ForcaMonthlyCalendarScreen.tsx instead passes the exact displayed
// month's range, so browsing an older/further month still works.
const DEFAULT_WINDOW_PAST_DAYS = 2;
const DEFAULT_WINDOW_FUTURE_DAYS = 14;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance === 'none') return json(403, { error: 'forbidden' });

  let fromRaw = event.queryStringParameters?.from ?? '';
  let toRaw = event.queryStringParameters?.to ?? '';
  if ((!fromRaw || !toRaw) && event.body) {
    try {
      const body = JSON.parse(event.body) as { from?: unknown; to?: unknown };
      if (!fromRaw && typeof body.from === 'string') fromRaw = body.from;
      if (!toRaw && typeof body.to === 'string') toRaw = body.to;
    } catch { /* ignore */ }
  }
  const now = Date.now();
  const from = fromRaw || new Date(now - DEFAULT_WINDOW_PAST_DAYS * 86400000).toISOString();
  const to = toRaw || new Date(now + DEFAULT_WINDOW_FUTURE_DAYS * 86400000).toISOString();

  const dayResults = await Promise.all(israelDateStrRange(from, to).map((dateStr) => ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    FilterExpression: 'attribute_exists(groupId)',
    ExpressionAttributeValues: { ':pk': `CLASSDATE#${dateStr}` },
  }))));
  const allSessionItems = dayResults.flatMap((r) => (r.Items ?? []) as (ClassItem & { PK: string })[]);
  const sessionItems = allSessionItems.filter((s) => sessionInAccess(access, s, callerUid));

  const lookups = await fetchSessionLookups(sessionItems);
  const sessions = await Promise.all(sessionItems.map((session) => resolveSessionDetail(session, lookups, access)));

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  return json(200, { sessions });
}
