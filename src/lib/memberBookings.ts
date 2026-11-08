import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { getUid, json } from './http';
import { isAdmin } from './auth';
import type { ClassItem, RegistrationItem } from './entities';

// GET /getMemberBookings?memberId=xxx&limit=20&cursor=<opaque>
// Auth: Cognito JWT. Defaults to the caller's own bookings; another memberId
// requires admin (same rule as getClasses.ts / getActivityHistory.ts).
// Rides incoreWorkoutApi.ts's shared integration (300-integration cap).
//
// INCORE profile "Bookings" tab, newest first (latest class date at the top),
// one page at a time. The order is decided here, not on the client, so page 2
// always continues where page 1 stopped.
//
// GSI1SK is REG#<month>#<classId>, so the index only orders by month, not by
// day or time. A member holds a few hundred registrations at most, so this
// reads all of them, takes each class's real date from the class item (the
// registration's classDate is a copy taken at booking time and goes stale if
// the class is moved), sorts, and returns the page after the cursor. The
// cursor is "<dateIso>|<classId>" of the last row returned, so a booking made
// between page loads can't shift or repeat rows.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface MemberBookingRow {
  id: string;
  classType: string;
  date: string;
  registered: number;
  capacity: number;
  consumedFrom: string | null;
  isPrivate: boolean;
}

/** Newest first; ties (same start time) broken by classId so the order is total. */
export function compareBookingsDesc(a: { date: string; id: string }, b: { date: string; id: string }): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function encodeBookingCursor(row: { date: string; id: string }): string {
  return Buffer.from(`${row.date}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeBookingCursor(cursor: string): { date: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    // The ISO date never contains '|'; the class id might.
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const date = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!id || isNaN(new Date(date).getTime())) return null;
    return { date, id };
  } catch {
    return null;
  }
}

/** One page of `rows` (already sorted newest first) after `cursor`. */
export function pageBookings<T extends { date: string; id: string }>(
  rows: T[], limit: number, cursor: { date: string; id: string } | null,
): { items: T[]; nextCursor: string | null } {
  const start = cursor ? rows.findIndex((r) => compareBookingsDesc(cursor, r) < 0) : 0;
  if (start < 0) return { items: [], nextCursor: null };
  const items = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  return { items, nextCursor: hasMore && items.length > 0 ? encodeBookingCursor(items[items.length - 1]) : null };
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

  const parsedLimit = parseInt(qs.limit ?? '', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = qs.cursor ? decodeBookingCursor(qs.cursor) : null;
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
  rows.sort(compareBookingsDesc);

  const page = pageBookings(rows, limit, cursor);
  return json(200, { items: page.items, nextCursor: page.nextCursor, total: rows.length });
}
