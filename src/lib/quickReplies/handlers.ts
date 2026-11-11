import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import type { MemberProfileItem } from '../entities';
import {
  canUseReply, duplicateShortcut, FORCA_MEMBER_SEED, FORCA_SEED, INCORE_SEED, memberMsgSk, QUICKREPLY_PK, reorder,
  replySk, SEED_SK, validateMemberMessage, validateReply,
  type Brand, type MemberQuickMessage, type QuickReply, type StaffRole,
} from './rules';

// Quick replies (Manage → תגובות מהירות, and the chat's ⚡ / "/" picker).
// Four routes on the shared integration (incoreWorkoutApi.ts):
//   GET  adminListQuickReplies?brand=     admin: everything, incl. inactive + usage counts
//   POST adminSaveQuickReplies            admin: { brand, action: save | delete | duplicate | reorder, … }
//   GET  getQuickReplies?brand=           the chat: replies this caller may use / member quick messages
//   POST useQuickReply                    the chat: { brand, id } counts one use
// Rules: rules.ts. All new routes; nothing an existing build calls changes.

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

const tableFor = (brand: Brand) => (brand === 'forca' ? FORCA_TABLE_NAME : TABLE_NAME);
const brandOf = (v: unknown): Brand | null => (v === 'incore' || v === 'forca' ? v : null);

async function loadAll(brand: Brand): Promise<{ replies: QuickReply[]; memberMessages: MemberQuickMessage[]; seeded: boolean }> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: tableFor(brand),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': QUICKREPLY_PK },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;
  return {
    seeded: items.some((i) => i.SK === SEED_SK),
    replies: items.filter((i) => String(i.SK).startsWith('REPLY#')).map((i) => ({
      id: String(i.id), shortcut: String(i.shortcut ?? ''), title: String(i.title ?? ''), text: String(i.text ?? ''),
      category: String(i.category ?? ''), active: i.active !== false,
      visibleTo: (i.visibleTo === 'coach' || i.visibleTo === 'both' ? i.visibleTo : 'admin') as QuickReply['visibleTo'],
      order: Number(i.order ?? 0), usageCount: Number(i.usageCount ?? 0),
    })).sort(byOrder),
    memberMessages: items.filter((i) => String(i.SK).startsWith('MEMBERMSG#')).map((i) => ({
      id: String(i.id), text: String(i.text ?? ''), active: i.active !== false, order: Number(i.order ?? 0),
    })).sort(byOrder),
  };
}

/**
 * Inserts the default replies once per brand. The SEED marker is written
 * first with a condition, so two callers can't both seed; deleting every
 * reply later doesn't bring the defaults back.
 */
async function ensureSeeded(brand: Brand): Promise<void> {
  const table = tableFor(brand);
  const marker = await ddb.send(new GetCommand({ TableName: table, Key: { PK: QUICKREPLY_PK, SK: SEED_SK } }));
  if (marker.Item) return;
  const nowIso = new Date().toISOString();
  try {
    await ddb.send(new PutCommand({
      TableName: table,
      Item: { PK: QUICKREPLY_PK, SK: SEED_SK, seededAt: nowIso },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
  const replies = (brand === 'forca' ? FORCA_SEED : INCORE_SEED).map((r, order) => {
    const id = randomUUID();
    return { PK: QUICKREPLY_PK, SK: replySk(id), id, ...r, active: true, order, usageCount: 0, createdAt: nowIso, updatedAt: nowIso };
  });
  const memberMessages = brand === 'forca'
    ? FORCA_MEMBER_SEED.map((text, order) => {
      const id = randomUUID();
      return { PK: QUICKREPLY_PK, SK: memberMsgSk(id), id, text, active: true, order, createdAt: nowIso, updatedAt: nowIso };
    })
    : [];
  const all = [...replies, ...memberMessages];
  for (let i = 0; i < all.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: all.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));
  }
}

/** The caller's chat role: the admin (either brand), a FORCA coach, a FORCA member, or nobody. */
async function chatRole(uid: string): Promise<{ role: StaffRole | 'member' | null }> {
  if (await isAdmin(uid)) return { role: 'admin' };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return { role: null };
  return { role: profile.identity?.role === 'coach' ? 'coach' : 'member' };
}

// ── Admin ───────────────────────────────────────────────────────────────────

export async function adminListQuickReplies(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const brand = brandOf(event.queryStringParameters?.brand);
  if (!brand) return json(400, { error: 'invalid_brand' });
  await ensureSeeded(brand);
  const { replies, memberMessages } = await loadAll(brand);
  return json(200, { replies, memberMessages: brand === 'forca' ? memberMessages : [] });
}

export async function adminSaveQuickReplies(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const brand = brandOf(body.brand);
  if (!brand) return json(400, { error: 'invalid_brand' });
  const kind = body.kind === 'memberMessage' ? 'memberMessage' : 'reply';
  if (kind === 'memberMessage' && brand !== 'forca') return json(400, { error: 'forca_only' });
  const table = tableFor(brand);
  const nowIso = new Date().toISOString();
  await ensureSeeded(brand);
  const { replies, memberMessages } = await loadAll(brand);
  const id = typeof body.id === 'string' ? body.id : '';
  const list = kind === 'reply' ? replies : memberMessages;
  const sk = kind === 'reply' ? replySk : memberMsgSk;

  switch (body.action) {
    case 'save': {
      const item = (body.item && typeof body.item === 'object' ? body.item : {}) as Record<string, unknown>;
      const existing = id ? list.find((r) => r.id === id) : undefined;
      if (id && !existing) return json(404, { error: 'not_found' });
      const newId = existing?.id ?? randomUUID();
      if (kind === 'reply') {
        const v = validateReply(item, brand, replies, existing?.id);
        if (!v.ok) return json(400, { error: v.error });
        const prev = existing as QuickReply | undefined;
        await ddb.send(new PutCommand({
          TableName: table,
          Item: {
            PK: QUICKREPLY_PK, SK: sk(newId), id: newId, ...v.value,
            order: prev?.order ?? replies.length, usageCount: prev?.usageCount ?? 0, updatedAt: nowIso,
            ...(prev ? {} : { createdAt: nowIso }),
          },
        }));
      } else {
        const v = validateMemberMessage(item);
        if (!v.ok) return json(400, { error: v.error });
        await ddb.send(new PutCommand({
          TableName: table,
          Item: { PK: QUICKREPLY_PK, SK: sk(newId), id: newId, ...v.value, order: existing?.order ?? memberMessages.length, updatedAt: nowIso },
        }));
      }
      return json(200, { success: true, id: newId });
    }
    case 'delete': {
      if (!list.some((r) => r.id === id)) return json(404, { error: 'not_found' });
      await ddb.send(new DeleteCommand({ TableName: table, Key: { PK: QUICKREPLY_PK, SK: sk(id) } }));
      return json(200, { success: true });
    }
    case 'duplicate': {
      if (kind !== 'reply') return json(400, { error: 'invalid_action' });
      const src = replies.find((r) => r.id === id);
      if (!src) return json(404, { error: 'not_found' });
      const newId = randomUUID();
      // Lands right after the original; later ones move down one.
      const at = replies.findIndex((r) => r.id === src.id) + 1;
      const order = [...replies.slice(0, at).map((r) => r.id), newId, ...replies.slice(at).map((r) => r.id)];
      await ddb.send(new PutCommand({
        TableName: table,
        Item: {
          PK: QUICKREPLY_PK, SK: sk(newId), id: newId,
          shortcut: duplicateShortcut(src.shortcut, replies), title: `${src.title} (עותק)`, text: src.text,
          category: src.category, active: src.active, visibleTo: src.visibleTo,
          order: src.order + 1, usageCount: 0, createdAt: nowIso, updatedAt: nowIso,
        },
      }));
      await writeOrder(table, sk, reorder([...replies, { id: newId, order: Number.MAX_SAFE_INTEGER }], order));
      return json(200, { success: true, id: newId });
    }
    case 'reorder': {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
      await writeOrder(table, sk, reorder(list, ids));
      return json(200, { success: true });
    }
    default:
      return json(400, { error: 'invalid_action' });
  }
}

async function writeOrder(table: string, sk: (id: string) => string, order: { id: string; order: number }[]): Promise<void> {
  await Promise.all(order.map((o) => ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: QUICKREPLY_PK, SK: sk(o.id) },
    UpdateExpression: 'SET #o = :o',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: { '#o': 'order' },
    ExpressionAttributeValues: { ':o': o.order },
  })).catch((err) => {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  })));
}

// ── Chat ────────────────────────────────────────────────────────────────────

/**
 * What the caller may use while chatting:
 *   admin  ?brand=incore|forca  active replies for the admin
 *   coach  (FORCA)              active replies for coaches
 *   member (FORCA)              the active quick messages
 */
export async function getQuickReplies(event: Event): Promise<Result> {
  const { role } = await chatRole(getUid(event));
  if (!role) return json(200, { replies: [], memberMessages: [] });
  const brand: Brand = role === 'admin' ? (brandOf(event.queryStringParameters?.brand) ?? 'incore') : 'forca';
  await ensureSeeded(brand);
  const { replies, memberMessages } = await loadAll(brand);
  if (role === 'member') {
    return json(200, { replies: [], memberMessages: memberMessages.filter((m) => m.active).map(({ id, text }) => ({ id, text })) });
  }
  return json(200, {
    replies: replies.filter((r) => canUseReply(r, role, brand)).map(({ id, shortcut, title, text, category }) => ({ id, shortcut, title, text, category })),
    memberMessages: [],
  });
}

/** Counts one use (shown on the management screen to spot unused replies). */
export async function useQuickReply(event: Event): Promise<Result> {
  const { role } = await chatRole(getUid(event));
  if (role !== 'admin' && role !== 'coach') return json(403, { error: 'forbidden' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const brand: Brand = role === 'admin' ? (brandOf(body.brand) ?? 'incore') : 'forca';
  const id = typeof body.id === 'string' ? body.id : '';
  const res = await ddb.send(new GetCommand({ TableName: tableFor(brand), Key: { PK: QUICKREPLY_PK, SK: replySk(id) } }));
  const reply = res.Item as QuickReply | undefined;
  if (!reply) return json(404, { error: 'not_found' });
  if (!canUseReply({ active: reply.active !== false, visibleTo: reply.visibleTo ?? 'admin' }, role, brand)) return json(403, { error: 'forbidden' });
  await ddb.send(new UpdateCommand({
    TableName: tableFor(brand),
    Key: { PK: QUICKREPLY_PK, SK: replySk(id) },
    UpdateExpression: 'ADD usageCount :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
  return json(200, { success: true });
}
