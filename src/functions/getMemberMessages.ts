import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { decodeRowCursor, windowRows } from '../lib/datePaging';
import { getUid, json } from '../lib/http';

// GET or POST /getMemberMessages
// Auth: Cognito JWT (own messages only)
// PK=MEMBER#<uid> SK=MESSAGE#<id> — in-app notification messages (waitlist
// offers, schedule changes, admin broadcasts). No AWS WebSocket transport
// exists yet, so the client polls this instead of the old Firestore
// onSnapshot listener.
//
// Messages live in whichever table the member's own profile lives in — a
// FORCA trainee's broadcasts are written to FORCA_TABLE_NAME (see
// templateBroadcast.ts), so this can't just hardcode the incore table
// anymore. resolveMemberProfile() checks both tables for this uid (no
// brand-aware signal on the JWT itself — see its own comment).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(200, { messages: [] });

  const qs = event.queryStringParameters ?? {};
  const paged = qs.paged === '1' || qs.paged === 'true';
  const cursor = paged && qs.cursor ? decodeRowCursor(qs.cursor) : null;
  if (paged && qs.cursor && !cursor) return json(400, { error: 'invalid_cursor' });

  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: resolved.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'MESSAGE#' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const now = new Date();
  const messages = items
    .filter((m) => !m.expiresAt || new Date(m.expiresAt as string) > now)
    .map((m) => ({
      id: (m.SK as string).replace('MESSAGE#', ''),
      type: m.type,
      title: m.title ?? '',
      body: m.body ?? '',
      bgColor: m.bgColor,
      textColor: m.textColor,
      classId: m.classId,
      className: m.className,
      classDate: m.classDate ?? null,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt ?? null,
      requiresAction: !!m.requiresAction,
      actionExpiresAt: m.actionExpiresAt ?? null,
      read: !!m.read,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  if (!paged) return json(200, { messages });

  // ?paged=1 (app 1.5.2+): every unread message is on page 1 (the badge and
  // any pending action stay complete), plus read ones from the last 2
  // months; Load more pages back through older read ones. Most messages
  // expire within days, but membership reminders and billing-failure notes
  // don't, so the list can grow. SK is MESSAGE#<id> (not date-sorted), so
  // this windows in memory.
  const unread = cursor ? [] : messages.filter((m) => !m.read);
  const read = messages.filter((m) => m.read).map((m) => ({ m, date: String(m.createdAt ?? '1970-01-01T00:00:00.000Z'), id: m.id }));
  const page = windowRows(read, cursor);
  const out = [...unread, ...page.items.map((x) => x.m)]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return json(200, { messages: out, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom });
}
