import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { forcaChatAccess, RECIPIENT_UNREAD_FILTER, toThreadRow } from '../lib/forcaChat/access';
import { coachPartitions, countInbox, decodeInboxCursor, pageInbox, resolveChatCaller, type InboxPartition } from '../lib/forcaChat/store';

const PAGE_SIZE = 30;
const ALL = 5000;

// GET or POST /getCoachForcaInquiries
// Auth: Cognito JWT, a coach (or an admin, who gets every coach thread).
// A coach sees ONLY threads addressed to her, plus pre-rebuild group threads
// of the groups she's in now. Never the admin's threads or another coach's.
// Reads her own inbox partitions on GSI3; no table scan.
//   ?unreadCount=1        just { unreadCount } for the tab badge
//   ?paged=1&cursor=<c>   newest activity first, 30 a page, { nextCursor }
//   (no params)           the whole list, for builds in the stores
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const caller = await resolveChatCaller(getUid(event));
  if (!caller.isAdmin && !caller.coachGroupIds) return json(403, { error: 'forbidden' });
  const q = event.queryStringParameters ?? {};
  const flag = (v: string | undefined) => v === '1' || v === 'true';

  const partitions: InboxPartition[] = caller.isAdmin
    ? [{ index: 'GSI2', pk: 'FORCAINQUIRY', filter: { expr: 'recipientRole = :coach', values: { ':coach': 'coach' } } }]
    : coachPartitions(caller.uid, caller.coachGroupIds ?? []).map((pk) => ({ index: 'GSI3', pk }));

  if (flag(q.unreadCount)) {
    if (caller.isAdmin) return json(200, { unreadCount: 0 });
    const unreadCount = await countInbox(partitions.map((p) => ({ index: 'GSI3' as const, pk: p.pk, filter: RECIPIENT_UNREAD_FILTER })));
    return json(200, { unreadCount });
  }

  const paged = flag(q.paged);
  const before = paged && q.cursor ? decodeInboxCursor(q.cursor) : null;
  if (paged && q.cursor && !before) return json(400, { error: 'invalid_cursor' });

  const page = await pageInbox(partitions, before, paged ? PAGE_SIZE : ALL);
  const inquiries = page.items.flatMap((t) => {
    const access = forcaChatAccess(t, caller);
    return access ? [toThreadRow(t, access)] : [];
  });
  return json(200, paged ? { inquiries, nextCursor: page.nextCursor } : { inquiries });
}
