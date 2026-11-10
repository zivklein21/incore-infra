import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { pageInquiries } from '../lib/inquiryPaging';
import type { ForcaSupportInquiryItem } from '../lib/entities';
import { forcaChatAccess, memberUnreadFilter, toThreadRow, type ChatCaller } from '../lib/forcaChat/access';
import { countInbox } from '../lib/forcaChat/store';

// GET or POST /getMyForcaInquiries
// Auth: Cognito JWT. Only the caller's OWN threads: a parent never sees her
// child's, a child never sees her parent's.
//   ?childUid=<uid>  a parent's own threads about that child (family-link
//                    checked). Builds in the stores send it from the child
//                    switcher; it no longer shows the child's threads.
//   ?paged=1         every open thread, plus closed ones from the last 2
//                    months; Load more pages back through closed ones.
//   ?unreadCount=1   just { unreadCount } for the badge.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const q = event.queryStringParameters ?? {};
  const flag = (v: string | undefined) => v === '1' || v === 'true';

  if (flag(q.unreadCount)) {
    const unreadCount = await countInbox([{ index: 'GSI1', pk: `MEMBER#${callerUid}`, skPrefix: 'FORCAINQUIRY#', filter: memberUnreadFilter(callerUid) }]);
    return json(200, { unreadCount });
  }

  const childUid = typeof q.childUid === 'string' ? q.childUid.trim() : '';
  if (childUid) {
    const link = await verifyFamilyLink(callerUid, childUid);
    if (!link.ok) return json(403, { error: 'forbidden' });
  }

  const items: ForcaSupportInquiryItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':prefix': 'FORCAINQUIRY#' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...((res.Items ?? []) as ForcaSupportInquiryItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const me: ChatCaller = { uid: callerUid, isAdmin: false, coachGroupIds: null };
  const inquiries = items
    .flatMap((t) => {
      const access = forcaChatAccess(t, me);
      // A parent's pre-rebuild thread can still sit under the child until the migration moves it.
      return access?.side === 'member' ? [toThreadRow(t, access)] : [];
    })
    .filter((r) => !childUid || r.aboutChildUid === childUid)
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? '').localeCompare(a.lastMessageAt ?? a.createdAt ?? ''));

  if (!flag(q.paged)) return json(200, { inquiries });
  const page = pageInquiries(inquiries, q.cursor);
  if (!page.ok) return json(400, { error: 'invalid_cursor' });
  return json(200, { inquiries: page.inquiries, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom });
}
