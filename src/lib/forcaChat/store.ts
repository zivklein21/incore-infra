import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { isAdmin } from '../auth';
import { notifyAdmins } from '../adminNotify';
import { getExpoPushToken, sendExpoPush } from '../push';
import { deriveMemberName, type ForcaSupportInquiryItem, type MemberProfileItem } from '../entities';
import {
  activitySk, isGroupThread, ownerOf, readMarkerField, recipientPartition,
  type ChatCaller, type ChatSide,
} from './access';

// DynamoDB side of the FORCA chat. Rules live in access.ts.

export interface ResolvedChatCaller extends ChatCaller {
  /** The caller's FORCA profile (members and coaches; admins live in the INCORE table). */
  profile: MemberProfileItem | null;
}

export async function resolveChatCaller(uid: string): Promise<ResolvedChatCaller> {
  const [admin, res] = await Promise.all([
    isAdmin(uid),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } })),
  ]);
  const profile = (res.Item as MemberProfileItem | undefined) ?? null;
  const isCoach = !admin && profile?.identity?.role === 'coach';
  return { uid, isAdmin: admin, coachGroupIds: isCoach ? (profile?.identity?.groupIds ?? []) : null, profile };
}

export async function getThread(id: string): Promise<ForcaSupportInquiryItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `FORCAINQUIRY#${id}`, SK: 'METADATA' } }));
  return (res.Item as ForcaSupportInquiryItem | undefined) ?? null;
}

export interface ForcaCoach { uid: string; name: string; groupIds: string[]; profile: MemberProfileItem }

/** Every FORCA coach. Scans profiles (coaches carry no index), so only called when choosing a recipient, never on a poll. */
export async function listForcaCoaches(): Promise<ForcaCoach[]> {
  const coaches: ForcaCoach[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :profile AND #identity.#role = :coach',
      ExpressionAttributeNames: { '#identity': 'identity', '#role': 'role' },
      ExpressionAttributeValues: { ':prefix': 'MEMBER#', ':profile': 'PROFILE', ':coach': 'coach' },
      ExclusiveStartKey: lastKey,
    }));
    for (const p of (res.Items ?? []) as MemberProfileItem[]) {
      coaches.push({ uid: p.PK.replace('MEMBER#', ''), name: deriveMemberName(p), groupIds: p.identity?.groupIds ?? [], profile: p });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return coaches.sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

// ── Inbox paging: newest activity first, across one or more partitions ─────

export interface InboxPartition {
  index: 'GSI2' | 'GSI3';
  pk: string;
  filter?: { expr: string; names?: Record<string, string>; values?: Record<string, unknown> };
}

export function encodeInboxCursor(sk: string): string {
  return Buffer.from(sk, 'utf8').toString('base64url');
}

/** A cursor is the activity sort key of the last row shown: `<iso>#<id>`. */
export function decodeInboxCursor(cursor: string): string | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const iso = raw.split('#')[0];
    return iso && !isNaN(new Date(iso).getTime()) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * One page of threads below the cursor, newest activity first. Each partition
 * gives its own newest `limit + 1` rows below the boundary; the merged top
 * `limit` are then exactly the next page, and anything left over means there's
 * more. A coach's inbox is her own partition plus her groups' old group threads.
 */
export async function pageInbox(
  partitions: InboxPartition[],
  before: string | null,
  limit: number,
): Promise<{ items: ForcaSupportInquiryItem[]; nextCursor: string | null }> {
  const perPartition = await Promise.all(partitions.map(async (p) => {
    const pkAttr = `${p.index}PK`;
    const skAttr = `${p.index}SK`;
    const found: ForcaSupportInquiryItem[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: FORCA_TABLE_NAME,
        IndexName: p.index,
        KeyConditionExpression: before ? '#pk = :pk AND #sk < :before' : '#pk = :pk',
        ...(p.filter ? { FilterExpression: p.filter.expr } : {}),
        ExpressionAttributeNames: { '#pk': pkAttr, ...(before ? { '#sk': skAttr } : {}), ...(p.filter?.names ?? {}) },
        ExpressionAttributeValues: { ':pk': p.pk, ...(before ? { ':before': before } : {}), ...(p.filter?.values ?? {}) },
        ScanIndexForward: false,
        Limit: limit + 1,
        ExclusiveStartKey: lastKey,
      }));
      found.push(...((res.Items ?? []) as ForcaSupportInquiryItem[]));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey && found.length <= limit);
    return found.map((item) => ({ item, sk: String((item as unknown as Record<string, unknown>)[skAttr] ?? '') }));
  }));

  const seen = new Set<string>();
  const merged = perPartition.flat()
    .sort((a, b) => b.sk.localeCompare(a.sk))
    .filter(({ item }) => (seen.has(item.PK) ? false : (seen.add(item.PK), true)));
  const page = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  return { items: page.map((r) => r.item), nextCursor: hasMore && page.length ? encodeInboxCursor(page[page.length - 1].sk) : null };
}

/** Badge count: one Select COUNT query per partition, never the whole table. */
export async function countInbox(partitions: { index: 'GSI1' | 'GSI2' | 'GSI3'; pk: string; skPrefix?: string; filter: NonNullable<InboxPartition['filter']> }[]): Promise<number> {
  const counts = await Promise.all(partitions.map(async (p) => {
    let n = 0;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: FORCA_TABLE_NAME,
        IndexName: p.index,
        Select: 'COUNT',
        KeyConditionExpression: p.skPrefix ? '#pk = :pk AND begins_with(#sk, :skPrefix)' : '#pk = :pk',
        FilterExpression: p.filter.expr,
        ExpressionAttributeNames: { '#pk': `${p.index}PK`, ...(p.skPrefix ? { '#sk': `${p.index}SK` } : {}), ...(p.filter.names ?? {}) },
        ExpressionAttributeValues: { ':pk': p.pk, ...(p.skPrefix ? { ':skPrefix': p.skPrefix } : {}), ...p.filter.values },
        ExclusiveStartKey: lastKey,
      }));
      n += res.Count ?? 0;
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return n;
  }));
  return counts.reduce((a, b) => a + b, 0);
}

/** A coach's inbox: threads addressed to her, plus old group threads of her current groups. */
export function coachPartitions(coachUid: string, groupIds: string[]): string[] {
  return [`FORCACHAT#coach#${coachUid}`, ...groupIds.map((g) => `FORCACHAT#group#${g}`)];
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** Sets this side's read marker. No-op for the admin watching a coach thread. */
export async function markRead(thread: ForcaSupportInquiryItem, side: ChatSide, atIso: string): Promise<void> {
  const field = readMarkerField(side);
  if (!field) return;
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: thread.PK, SK: 'METADATA' },
    UpdateExpression: 'SET #f = :at',
    ExpressionAttributeNames: { '#f': field },
    ExpressionAttributeValues: { ':at': atIso },
  }));
}

/**
 * New last message: moves the thread to the top of every inbox it's in and
 * marks it read for the side that wrote it. `sender` absent = a system line
 * (closing), which leaves lastSender alone.
 */
export async function touchThread(
  thread: ForcaSupportInquiryItem,
  update: { text: string; atIso: string; sender?: 'member' | 'admin' | 'coach'; side?: ChatSide; status?: 'CLOSED' },
): Promise<void> {
  const id = thread.PK.replace('FORCAINQUIRY#', '');
  const sk = activitySk(update.atIso, id);
  const sets = ['lastMessage = :text', 'lastMessageAt = :now', 'GSI2SK = :sk'];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':text': update.text, ':now': update.atIso, ':sk': sk };
  const partition = thread.GSI3PK ?? recipientPartition(thread);
  if (partition) {
    sets.push('GSI3PK = :gsi3pk', 'GSI3SK = :sk');
    values[':gsi3pk'] = partition;
  }
  if (update.sender) {
    sets.push('lastSender = :sender');
    values[':sender'] = update.sender;
  }
  const marker = update.side ? readMarkerField(update.side) : null;
  if (marker) {
    sets.push(`${marker} = :now`);
  }
  if (update.status) {
    sets.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = update.status;
  }
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: thread.PK, SK: 'METADATA' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }));
}

// ── Push ────────────────────────────────────────────────────────────────────

async function pushToUid(uid: string, title: string, body: string, data: Record<string, unknown>): Promise<void> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  const profile = res.Item as MemberProfileItem | undefined;
  const token = profile ? getExpoPushToken(profile) : null;
  if (token) await sendExpoPush(token, title, body, data);
}

/**
 * A member wrote: tell the recipient (the admins, or her one coach; an old
 * group thread still goes to the group's coaches). The other side wrote:
 * tell the thread's owner only, never her parent or child.
 * Never throws: a failed push must not fail the message.
 */
export async function notifyChat(thread: ForcaSupportInquiryItem, sender: 'member' | 'admin' | 'coach', text: string): Promise<void> {
  try {
    const id = thread.PK.replace('FORCAINQUIRY#', '');
    const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    if (sender === 'member') {
      const from = thread.ownerName ?? (thread.payerUid ? thread.payerName : thread.userDisplayName) ?? 'מתאמנת';
      const title = `הודעה חדשה מ${from}`;
      if (thread.recipientRole === 'admin') {
        await notifyAdmins({
          type: 'FORCA_INQUIRY', priority: 'NORMAL', brand: 'forca', pushTitle: title, message: preview,
          extra: { inquiryId: id }, pushData: { screen: 'SupportInquiries', inquiryId: id },
        });
        return;
      }
      const data = { screen: 'ForcaCoachInquiries', inquiryId: id };
      if (thread.recipientUid) {
        await pushToUid(thread.recipientUid, title, preview, data);
        return;
      }
      if (isGroupThread(thread) && thread.groupId) {
        const coaches = (await listForcaCoaches()).filter((c) => c.groupIds.includes(thread.groupId!));
        await Promise.all(coaches.map(async (c) => {
          const token = getExpoPushToken(c.profile);
          if (token) await sendExpoPush(token, title, preview, data);
        }));
      }
      return;
    }
    const title = sender === 'coach' ? `הודעה חדשה מ${thread.recipientName ?? 'המאמנת'}` : 'הודעה חדשה מהמנהלת';
    await pushToUid(ownerOf(thread), title, preview, { screen: 'ForcaChat', inquiryId: id });
  } catch (err) {
    console.error('[forcaChat.notifyChat] failed:', err);
  }
}
