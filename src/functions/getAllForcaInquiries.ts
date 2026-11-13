import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ForcaSupportInquiryItem, MemberProfileItem } from '../lib/entities';
import {
  ADMIN_PARTITION, forcaChatAccess, RECIPIENT_UNREAD_FILTER, toThreadRow, type ChatCaller,
} from '../lib/forcaChat/access';
import { coachPartitions, countInbox, decodeInboxCursor, pageInbox, type InboxPartition } from '../lib/forcaChat/store';

const PAGE_SIZE = 30;
const ALL = 5000;

// GET or POST /getAllForcaInquiries
// Auth: Cognito JWT, admin only. The admin sees every FORCA thread.
//   ?box=mine                threads addressed to her (GSI3 FORCACHAT#admin)
//   ?box=coaches[&coachUid=] threads to coaches, or to one coach (her inbox
//                            plus old group threads of her groups)
//   ?box=all                 everything (GSI2)
//   ?paged=1&cursor=<c>      newest activity first, 30 a page, { nextCursor }
//   ?unreadCount=1           { unreadCount } of threads addressed to her only
//   (no params)              every thread, for the Backoffice build in the stores
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });
  const q = event.queryStringParameters ?? {};
  const flag = (v: string | undefined) => v === '1' || v === 'true';

  if (flag(q.unreadCount)) {
    const unreadCount = await countInbox([{ index: 'GSI3', pk: ADMIN_PARTITION, filter: RECIPIENT_UNREAD_FILTER }]);
    return json(200, { unreadCount });
  }

  const box = q.box === 'mine' || q.box === 'coaches' ? q.box : 'all';
  let partitions: InboxPartition[];
  if (box === 'mine') {
    partitions = [{ index: 'GSI3', pk: ADMIN_PARTITION }];
  } else if (box === 'coaches' && q.coachUid) {
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${q.coachUid}`, SK: 'PROFILE' } }));
    const coach = res.Item as MemberProfileItem | undefined;
    if (coach?.identity?.role !== 'coach') return json(404, { error: 'coach_not_found' });
    partitions = coachPartitions(q.coachUid, coach.identity.groupIds ?? []).map((pk) => ({ index: 'GSI3', pk }));
  } else if (box === 'coaches') {
    partitions = [{ index: 'GSI2', pk: 'FORCAINQUIRY', filter: { expr: 'recipientRole = :coach', values: { ':coach': 'coach' } } }];
  } else {
    partitions = [{ index: 'GSI2', pk: 'FORCAINQUIRY' }];
  }

  const paged = flag(q.paged);
  const before = paged && q.cursor ? decodeInboxCursor(q.cursor) : null;
  if (paged && q.cursor && !before) return json(400, { error: 'invalid_cursor' });

  const page = await pageInbox(partitions, before, paged ? PAGE_SIZE : ALL);
  const admin: ChatCaller = { uid: callerUid, isAdmin: true, coachGroupIds: null };
  const inquiries = page.items.map((t: ForcaSupportInquiryItem) => toThreadRow(t, forcaChatAccess(t, admin)!));
  return json(200, paged ? { inquiries, nextCursor: page.nextCursor } : { inquiries });
}
