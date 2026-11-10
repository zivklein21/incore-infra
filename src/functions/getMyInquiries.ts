import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { pageInquiries } from '../lib/inquiryPaging';
import type { SupportInquiryItem } from '../lib/entities';
import { isIncoreUnreadFor } from '../lib/incoreChatRead';

// GET or POST /getMyInquiries
// Auth: Cognito JWT (own inquiries only)
// No AWS WebSocket transport exists yet, so the client polls this instead
// of the old Firestore onSnapshot listener.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'INQUIRY#' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const inquiries = (items as unknown as SupportInquiryItem[])
    .map((i) => ({
      id: i.PK.replace('INQUIRY#', ''),
      subject: i.subject ?? '',
      status: i.status,
      lastMessage: i.lastMessage ?? '',
      lastSender: i.lastSender ?? 'member',
      createdAt: i.createdAt ?? null,
      lastMessageAt: i.lastMessageAt ?? null,
      unread: isIncoreUnreadFor(i, 'member'),
    }))
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt ?? '').localeCompare(a.lastMessageAt ?? a.createdAt ?? ''));

  // ?paged=1 (app 1.5.2+): every open inquiry, plus closed ones from the
  // last 2 months; Load more pages back through closed ones.
  const qs = event.queryStringParameters ?? {};
  if (qs.paged !== '1' && qs.paged !== 'true') return json(200, { inquiries });
  const page = pageInquiries(inquiries, qs.cursor);
  if (!page.ok) return json(400, { error: 'invalid_cursor' });
  return json(200, { inquiries: page.inquiries, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom });
}
