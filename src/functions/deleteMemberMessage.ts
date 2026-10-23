import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json, errorMessage } from '../lib/http';

// POST /deleteMemberMessage
// Body: { messageId } | { messageIds: string[] } | { all: true }
// Auth: Cognito JWT (own messages only)
// Messages live in whichever table the member's own profile lives in —
// same resolveMemberProfile() dual-table lookup as getMemberMessages.ts's
// own read side (hardcoding TABLE_NAME here silently no-op'd for a FORCA
// member: the delete just missed, and her dismissed notification kept
// reappearing on every poll).
//
// Ownership is structural: every key is built from the JWT's own uid
// (PK=MEMBER#<uid>), never from the body, so a member can only ever address
// rows in her own inbox — a foreign messageId just misses. Each MESSAGE# row
// is a per-member copy (broadcasts fan out one row per recipient — see
// templateBroadcast.ts), so deleting it never touches another member's inbox
// or the class/payment/form it refers to.
//
// all:true ("Clear all") skips waitlist_offer rows — dismissing one of those
// means declining the spot (rejectWaitlistOffer), which a bulk clear must
// never do implicitly.
const MAX_IDS = 200;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { messageId?: unknown; messageIds?: unknown; all?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const all = body.all === true;
  const ids = new Set<string>();
  if (typeof body.messageId === 'string' && body.messageId.trim()) ids.add(body.messageId.trim());
  if (Array.isArray(body.messageIds)) {
    for (const id of body.messageIds) {
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
  }
  if (!all && ids.size === 0) return json(400, { error: 'missing_message_id' });
  if (ids.size > MAX_IDS) return json(400, { error: 'too_many_ids' });

  const resolved = await resolveMemberProfile(uid);
  if (!resolved) return json(200, { success: true, deletedCount: 0 });

  const pk = `MEMBER#${uid}`;
  try {
    if (all) {
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await ddb.send(new QueryCommand({
          TableName: resolved.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': 'MESSAGE#' },
          ProjectionExpression: 'SK, #type',
          ExpressionAttributeNames: { '#type': 'type' },
          ExclusiveStartKey: lastKey,
        }));
        for (const item of (res.Items ?? []) as { SK: string; type?: string }[]) {
          if (item.type !== 'waitlist_offer') ids.add(item.SK.replace('MESSAGE#', ''));
        }
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
    }

    await batchDelete(resolved.table, [...ids].map((id) => ({ PK: pk, SK: `MESSAGE#${id}` })));
  } catch (err) {
    console.error(`[deleteMemberMessage] uid=${uid} failed:`, errorMessage(err));
    return json(500, { error: 'delete_failed' });
  }

  return json(200, { success: true, deletedCount: ids.size });
}

async function batchDelete(table: string, keys: { PK: string; SK: string }[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let requests: Record<string, any>[] = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    // Retry throttled leftovers a few times before giving up — a partial
    // clear must surface as an error so the client can roll back.
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt >= 4) throw new Error('unprocessed_items');
      if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
      requests = (res.UnprocessedItems?.[table] ?? []) as Record<string, any>[];
    }
  }
}
