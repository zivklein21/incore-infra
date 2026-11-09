import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import { fetchSessionLookups, resolveSessionDetail, type RosterEntryDetail } from '../lib/sessionDetail';
import type { ClassItem } from '../lib/entities';
import { israelDateStrRange } from '../lib/sessionInstance';
import { decodeIsoCursor, encodeIsoCursor, HISTORY_WINDOW_MONTHS, monthsBefore } from '../lib/datePaging';

// GET or POST /getTrainingHistory
// Auth: Cognito JWT, admin or a coach with attendance !== 'none' (Coach
// Role epic — Training History tab, item 4: mirrors this same admin audit
// log, scoped to her own sessions via sessionInAccess(), same as
// getCoachSessions.ts). Her attendance-editing lock once a session is
// closedAt is enforced client-side here (this endpoint has no closedAt
// guard itself, same as adminUpdateSessionInstance.ts) — but her
// underlying write, markActualAttendance.ts, already 403s her once
// closedAt is set regardless, so the client-side lock is UX, not the
// actual security boundary.
//
// Lists every past FORCA training session (date < now), built on the same
// resolveSessionDetail() getCoachSessions.ts uses, with each roster entry
// additionally carrying attendanceMatch: whether the trainee's own
// self-reported arrival (declaredAttendance — declareAttendance.ts) matches
// what the coach actually recorded (actualAttendance — markActualAttendance.ts).
// null when there's nothing to compare yet (actual never recorded, or the
// trainee never declared) — a genuine "no signal" case, not a mismatch.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance === 'none') return json(403, { error: 'forbidden' });

  const qs = event.queryStringParameters ?? {};
  const nowIso = new Date().toISOString();
  let allSessionItems: (ClassItem & { PK: string })[];
  let paging: { nextCursor: string | null; coveredFrom: string } | null = null;

  if (qs.paged === '1' || qs.paged === 'true') {
    // App 1.5.2+: the last 2 months, then 2 months per Load more, read
    // day by day off GSI2 CLASSDATE#<date> instead of scanning the table.
    let upperIso = nowIso;
    if (qs.cursor) {
      const decoded = decodeIsoCursor(qs.cursor);
      if (!decoded) return json(400, { error: 'invalid_cursor' });
      upperIso = decoded;
    }
    const page = await pastSessionsWindow(upperIso);
    allSessionItems = page.items;
    paging = { nextCursor: page.nextFrom ? encodeIsoCursor(page.nextFrom) : null, coveredFrom: page.coveredFrom };
  } else {
    // Builds already in the stores: every past session, as before.
    allSessionItems = await scanPastSessions(nowIso);
  }
  const sessionItems = allSessionItems.filter((item) => sessionInAccess(access, item, callerUid));

  const lookups = await fetchSessionLookups(sessionItems);
  const sessions = await Promise.all(sessionItems.map(async (session) => {
    const detail = await resolveSessionDetail(session, lookups, access);
    // The medical alert is only for the live attendance list and test grading.
    const roster = detail.roster.map(({ medicalAlert: _, ...r }) => ({ ...r, attendanceMatch: computeAttendanceMatch({ ...r, medicalAlert: null }) }));
    return { ...detail, roster };
  }));

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  return json(200, paging ? { sessions, ...paging } : { sessions });
}

// Sessions recur weekly, so this many empty windows in a row (6 months with
// no session at all) means the start of the history has been reached.
const MAX_EMPTY_WINDOWS = 3;

/** Past group sessions in [upper - 2 months, upper), stepping further back over empty windows. */
async function pastSessionsWindow(upperIso: string): Promise<{
  items: (ClassItem & { PK: string })[]; nextFrom: string | null; coveredFrom: string;
}> {
  let upper = upperIso;
  for (let w = 0; w < MAX_EMPTY_WINDOWS; w++) {
    const lower = monthsBefore(upper, HISTORY_WINDOW_MONTHS);
    // israelDateStrRange excludes its end day, so run one day past `upper`
    // and trim by the real start instant below.
    const dayAfter = new Date(new Date(upper).getTime() + 86400000).toISOString();
    const dayResults = await Promise.all(israelDateStrRange(lower, dayAfter).map((dateStr) => ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      FilterExpression: 'attribute_exists(groupId) AND #dt >= :lower AND #dt < :upper',
      ExpressionAttributeNames: { '#dt': 'date' },
      ExpressionAttributeValues: { ':pk': `CLASSDATE#${dateStr}`, ':lower': lower, ':upper': upper },
    }))));
    const items = dayResults.flatMap((r) => (r.Items ?? []) as (ClassItem & { PK: string })[]);
    if (items.length > 0) return { items, nextFrom: lower, coveredFrom: lower };
    upper = lower;
  }
  return { items: [], nextFrom: null, coveredFrom: upper };
}

async function scanPastSessions(nowIso: string): Promise<(ClassItem & { PK: string })[]> {
  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getCoachSessions.ts. Follows every page (a single Scan
  // call stops at 1 MB).
  const out: (ClassItem & { PK: string })[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND attribute_exists(groupId) AND #dt < :now',
      ExpressionAttributeNames: { '#dt': 'date' },
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA', ':now': nowIso },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as (ClassItem & { PK: string })[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

function computeAttendanceMatch(entry: RosterEntryDetail): boolean | null {
  if (entry.actualAttendance === null || entry.declaredAttendance === 'pending') return null;
  const declaredYes = entry.declaredAttendance === 'yes';
  const actualPresent = entry.actualAttendance === 'present';
  return declaredYes === actualPresent;
}
