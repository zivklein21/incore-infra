import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ForcaSupportInquiryMessageItem } from '../lib/entities';
import { forcaChatAccess, toThreadRow } from '../lib/forcaChat/access';
import { getThread, markRead, resolveChatCaller } from '../lib/forcaChat/store';

const PAGE_SIZE = 30;

// GET or POST /getForcaInquiryMessages?inquiryId=xxx
// Auth: Cognito JWT. Same rule as everything else in the FORCA chat
// (lib/forcaChat/access.ts): the owner, the recipient, or an admin.
//   ?markRead=1           sets the caller's read marker (not for the admin
//                         watching a coach thread)
//   ?paged=1&cursor=<c>   the newest 30 messages, then older ones; each page
//                         is oldest-first, with { nextCursor } for older
//   (no params)           every message, oldest first (builds in the stores)
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const q = event.queryStringParameters ?? {};
  const inquiryId = q.inquiryId;
  if (!inquiryId) return json(400, { error: 'missing_inquiry_id' });
  const flag = (v: string | undefined) => v === '1' || v === 'true';

  const [thread, caller] = await Promise.all([getThread(inquiryId), resolveChatCaller(getUid(event))]);
  if (!thread) return json(404, { error: 'inquiry_not_found' });
  const access = forcaChatAccess(thread, caller);
  if (!access) return json(403, { error: 'forbidden' });

  if (flag(q.markRead)) await markRead(thread, access.side, new Date().toISOString());

  const toRow = (m: ForcaSupportInquiryMessageItem) => ({
    id: m.SK.replace('MESSAGE#', ''),
    text: m.text ?? '',
    sender: m.sender ?? 'member',
    senderName: m.senderName ?? null,
    messageKey: m.messageKey,
    isAutoReply: !!m.isAutoReply,
    createdAt: m.createdAt,
  });
  const byTime = (a: ForcaSupportInquiryMessageItem, b: ForcaSupportInquiryMessageItem) =>
    String(a.createdAt).localeCompare(String(b.createdAt)) || a.SK.localeCompare(b.SK);
  const threadRow = toThreadRow(thread, access);

  const paged = flag(q.paged);
  let cursor: { at: string; sk: string } | null = null;
  if (paged && q.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (typeof parsed?.at === 'string' && typeof parsed?.sk === 'string' && parsed.sk.startsWith('MESSAGE#')) cursor = parsed;
    } catch { /* invalid below */ }
    if (!cursor) return json(400, { error: 'invalid_cursor' });
  }
  const encode = (m: ForcaSupportInquiryMessageItem) => Buffer.from(JSON.stringify({ at: m.createdAt, sk: m.SK }), 'utf8').toString('base64url');

  // Threads started since the rebuild: page straight off the key.
  if (paged && thread.sortableMessages) {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: cursor ? 'PK = :pk AND SK < :before' : 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': thread.PK, ...(cursor ? { ':before': cursor.sk } : { ':prefix': 'MESSAGE#' }) },
      ScanIndexForward: false,
      Limit: PAGE_SIZE,
    }));
    const newestFirst = ((res.Items ?? []) as ForcaSupportInquiryMessageItem[]).filter((m) => m.SK.startsWith('MESSAGE#'));
    const oldest = newestFirst[newestFirst.length - 1];
    return json(200, {
      thread: threadRow,
      messages: [...newestFirst].reverse().map(toRow),
      nextCursor: res.LastEvaluatedKey && oldest ? encode(oldest) : null,
    });
  }

  const all: ForcaSupportInquiryMessageItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': thread.PK, ':prefix': 'MESSAGE#' },
      ExclusiveStartKey: lastKey,
    }));
    all.push(...((res.Items ?? []) as ForcaSupportInquiryMessageItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  all.sort(byTime);

  if (!paged) return json(200, { thread: threadRow, messages: all.map(toRow) });

  // Older threads (MESSAGE#<uuid> keys): same pages, cut in memory.
  const older = cursor ? all.filter((m) => byTime(m, { createdAt: cursor!.at, SK: cursor!.sk } as ForcaSupportInquiryMessageItem) < 0) : all;
  const pageItems = older.slice(-PAGE_SIZE);
  return json(200, {
    thread: threadRow,
    messages: pageItems.map(toRow),
    nextCursor: older.length > PAGE_SIZE ? encode(pageItems[0]) : null,
  });
}
