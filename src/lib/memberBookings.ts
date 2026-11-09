import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { getUid, json } from './http';
import { isAdmin } from './auth';
import type { ClassItem, RegistrationItem } from './entities';
import { decodeRowCursor, windowRows } from './datePaging';

// GET /getMemberBookings?memberId=xxx&cursor=<opaque>
// Auth: Cognito JWT. Defaults to the caller's own bookings; another memberId
// requires admin (same rule as getClasses.ts / getActivityHistory.ts).
// Rides incoreWorkoutApi.ts's shared integration (300-integration cap).
//
// INCORE profile "Bookings" tab, newest first (latest class date at the top),
// paged by TIME: the first page is every upcoming booking plus the last 2
// months; each Load more is the next 2 months back. A window with no
// bookings is skipped automatically, so a page is only empty when the member
// has no bookings at all, and nextCursor is null only when nothing older
// exists (lib/datePaging.ts windowRows).
//
// GSI1SK is REG#<month>#<classId>, so the index only orders by month, not by
// day or time. A member holds a few hundred registrations at most, so this
// reads all of them, takes each class's real date from the class item (the
// registration's classDate is a copy taken at booking time and goes stale if
// the class is moved), sorts, and returns the window after the cursor. The
// cursor is "<dateIso>|<classId>" of the last row returned, so a booking made
// between page loads can't shift or repeat rows. `limit` is accepted and
// ignored (it was the page size before paging moved to time windows).

export interface MemberBookingRow {
  id: string;
  classType: string;
  date: string;
  registered: number;
  capacity: number;
  consumedFrom: string | null;
  isPrivate: boolean;
}

async function queryAllRegistrations(memberId: string): Promise<RegistrationItem[]> {
  const out: RegistrationItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as RegistrationItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function batchGetClasses(classIds: string[]): Promise<Map<string, ClassItem>> {
  const out = new Map<string, ClassItem>();
  for (let i = 0; i < classIds.length; i += 100) {
    let keys: Record<string, unknown>[] | undefined = classIds.slice(i, i + 100).map((id) => ({ PK: `CLASS#${id}`, SK: 'METADATA' }));
    // BatchGet may hand back part of the request as UnprocessedKeys under load.
    for (let attempt = 0; keys && keys.length > 0 && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: keys } } }));
      for (const item of (res.Responses?.[TABLE_NAME] ?? []) as ClassItem[]) {
        out.set(item.PK.replace('CLASS#', ''), item);
      }
      keys = res.UnprocessedKeys?.[TABLE_NAME]?.Keys as Record<string, unknown>[] | undefined;
      if (keys && keys.length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
  return out;
}

export async function getMemberBookings(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const qs = event.queryStringParameters ?? {};
  const memberId = qs.memberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const cursor = qs.cursor ? decodeRowCursor(qs.cursor) : null;
  if (qs.cursor && !cursor) return json(400, { error: 'invalid_cursor' });

  const registrations = await queryAllRegistrations(memberId);
  // One registration per class; keep the first if old data has duplicates.
  const regByClass = new Map<string, RegistrationItem>();
  for (const r of registrations) if (r.classId && !regByClass.has(r.classId)) regByClass.set(r.classId, r);

  const classes = await batchGetClasses([...regByClass.keys()]);

  const rows: MemberBookingRow[] = [];
  for (const [classId, reg] of regByClass) {
    const cls = classes.get(classId);
    const date = cls?.date ?? reg.classDate;
    if (!date || isNaN(new Date(date).getTime())) continue;
    rows.push({
      id: classId,
      classType: cls?.className ?? '',
      date: new Date(date).toISOString(),
      registered: cls?.currentAttendeesCount ?? 0,
      capacity: cls?.capacity ?? 5,
      consumedFrom: reg.consumedFrom ?? null,
      isPrivate: cls?.isPrivate === true,
    });
  }
  const page = windowRows(rows, cursor);
  return json(200, { items: page.items, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom, total: rows.length });
}
