import { DeleteCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from './dynamo';
import type { MemberProfileItem } from './entities';

// Every Expo push goes through sendExpoPushBatch() so Expo's replies are
// actually read. Expo reports problems in two places:
//  - tickets, returned by /push/send itself (bad token format,
//    DeviceNotRegistered for a token Expo already knows is dead, ...);
//  - receipts, ready ~15 min later from /push/getReceipts — this is where
//    FCM/APNs delivery failures surface (DeviceNotRegistered after an
//    uninstall, InvalidCredentials when the FCM V1 key in Expo is wrong, ...).
// Each accepted ticket is stored as a PUSHTICKET# item so checkPushReceipts.ts
// can fetch its receipt later; the item TTLs out after a day either way,
// since Expo only keeps receipts for 24 hours.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_SEND_CHUNK = 100;
const EXPO_RECEIPT_CHUNK = 1000;
const TICKET_TTL_SECONDS = 24 * 3600;
const RECEIPT_READY_AFTER_MS = 15 * 60 * 1000;
const PUSH_TICKET_GSI2PK = 'PUSHTICKET';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound?: 'default';
  data?: Record<string, unknown>;
}

export interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface ExpoReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export interface PushError { token: string; code: string; message: string }

interface PushTicketItem {
  PK: string; SK: string;
  ticketId: string;
  token: string;
  source: string;
  createdAt: string;
}

export function getExpoPushToken(profile: MemberProfileItem): string | null {
  const raw = profile.device?.expo_push_token ?? profile.device?.expoPushToken ?? profile.expoPushToken ?? '';
  return raw.startsWith('ExponentPushToken') ? raw : null;
}

/** Enough of the token to tell devices apart in logs without logging a usable token. */
export function maskPushToken(token: string): string {
  const m = token.match(/^(Expo(?:nent)?PushToken\[)(.{0,4})/);
  return m ? `${m[1]}${m[2]}…]` : `${token.slice(0, 4)}…`;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Tickets come back in the same order as the messages that were sent. */
export function classifyTickets(messages: ExpoPushMessage[], tickets: ExpoTicket[]): { accepted: { id: string; token: string }[]; errors: PushError[] } {
  const accepted: { id: string; token: string }[] = [];
  const errors: PushError[] = [];
  messages.forEach((msg, i) => {
    const t = tickets[i];
    if (!t) errors.push({ token: msg.to, code: 'NoTicket', message: 'Expo returned no ticket for this message' });
    else if (t.status === 'ok' && t.id) accepted.push({ id: t.id, token: msg.to });
    else errors.push({ token: msg.to, code: t.details?.error ?? 'Unknown', message: t.message ?? '' });
  });
  return { accepted, errors };
}

/** Splits stored tickets into those with a receipt (done, ok or error) and those still pending. */
export function classifyReceipts<T extends { ticketId: string; token: string }>(tickets: T[], receipts: Record<string, ExpoReceipt>): { done: T[]; pending: T[]; errors: PushError[] } {
  const done: T[] = [];
  const pending: T[] = [];
  const errors: PushError[] = [];
  for (const t of tickets) {
    const r = receipts[t.ticketId];
    if (!r) { pending.push(t); continue; }
    done.push(t);
    if (r.status === 'error') errors.push({ token: t.token, code: r.details?.error ?? 'Unknown', message: r.message ?? '' });
  }
  return { done, pending, errors };
}

/** Removes a dead token from whichever profile(s) still hold it — conditional, so a token the device re-registered in the meantime is never touched. */
export async function removePushToken(token: string): Promise<number> {
  let removed = 0;
  for (const tableName of [TABLE_NAME, FORCA_TABLE_NAME]) {
    let lastKey: Record<string, unknown> | undefined;
    do {
      // Scan, not a GSI: same <=50-users rationale as memberScan.ts, and this
      // only runs for the rare dead token.
      const res = await ddb.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'SK = :sk AND device.expo_push_token = :t',
        ExpressionAttributeValues: { ':sk': 'PROFILE', ':t': token },
        ProjectionExpression: 'PK',
        ExclusiveStartKey: lastKey,
      }));
      for (const item of res.Items ?? []) {
        try {
          await ddb.send(new UpdateCommand({
            TableName: tableName,
            Key: { PK: item.PK, SK: 'PROFILE' },
            UpdateExpression: 'REMOVE device.expo_push_token',
            ConditionExpression: 'device.expo_push_token = :t',
            ExpressionAttributeValues: { ':t': token },
          }));
          removed++;
        } catch (err: any) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
        }
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  }
  return removed;
}

async function handlePushErrors(errors: PushError[], source: string, stage: 'ticket' | 'receipt'): Promise<void> {
  for (const e of errors) {
    console.error(`[push:${source}] ${stage} error ${e.code} for ${maskPushToken(e.token)}: ${e.message}`);
    if (e.code === 'DeviceNotRegistered') {
      const removed = await removePushToken(e.token).catch((err) => {
        console.error(`[push:${source}] removing dead token ${maskPushToken(e.token)} failed:`, err);
        return 0;
      });
      console.log(`[push:${source}] removed dead token ${maskPushToken(e.token)} from ${removed} profile(s)`);
    }
  }
}

async function storeTickets(accepted: { id: string; token: string }[], source: string): Promise<void> {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAtEpoch = Math.floor(now.getTime() / 1000) + TICKET_TTL_SECONDS;
  await Promise.all(accepted.map((t) => ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `PUSHTICKET#${t.id}`, SK: 'METADATA',
      GSI2PK: PUSH_TICKET_GSI2PK, GSI2SK: createdAt,
      ticketId: t.id, token: t.token, source, createdAt, expiresAtEpoch,
    },
  })))).catch((err) => console.error(`[push:${source}] storing tickets failed:`, err));
}

/** Sends in chunks of 100 and returns how many messages Expo accepted. Never throws. */
export async function sendExpoPushBatch(messages: ExpoPushMessage[], source: string): Promise<number> {
  let acceptedCount = 0;
  for (const batch of chunk(messages, EXPO_SEND_CHUNK)) {
    try {
      const resp = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map((m) => ({ sound: 'default', ...m }))),
      });
      const result = await resp.json().catch(() => null) as { data?: ExpoTicket[]; errors?: unknown[] } | null;
      if (!resp.ok || !result || result.errors) {
        console.error(`[push:${source}] request failed (HTTP ${resp.status}) for ${batch.length} message(s):`, JSON.stringify(result?.errors ?? result));
        continue;
      }
      const { accepted, errors } = classifyTickets(batch, result.data ?? []);
      acceptedCount += accepted.length;
      await storeTickets(accepted, source);
      await handlePushErrors(errors, source, 'ticket');
    } catch (err: any) {
      console.error(`[push:${source}] send failed:`, err);
    }
  }
  return acceptedCount;
}

export async function sendExpoPush(token: string, title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  await sendExpoPushBatch([{ to: token, title, body, sound: 'default', ...(data ? { data } : {}) }], 'sendExpoPush');
}

/** Fetches receipts for tickets older than 15 min, logs errors, drops dead tokens, deletes finished tickets. */
export async function checkPushReceipts(): Promise<{ checked: number; ok: number; errors: number; pending: number }> {
  const cutoff = new Date(Date.now() - RECEIPT_READY_AFTER_MS).toISOString();
  const tickets: PushTicketItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :cutoff',
      ExpressionAttributeValues: { ':pk': PUSH_TICKET_GSI2PK, ':cutoff': cutoff },
      ExclusiveStartKey: lastKey,
    }));
    tickets.push(...(res.Items ?? []) as PushTicketItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const summary = { checked: tickets.length, ok: 0, errors: 0, pending: 0 };
  for (const batch of chunk(tickets, EXPO_RECEIPT_CHUNK)) {
    const resp = await fetch(EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: batch.map((t) => t.ticketId) }),
    });
    const result = await resp.json().catch(() => null) as { data?: Record<string, ExpoReceipt>; errors?: unknown[] } | null;
    if (!resp.ok || !result || result.errors) {
      console.error(`[push:receipts] request failed (HTTP ${resp.status}):`, JSON.stringify(result?.errors ?? result));
      summary.pending += batch.length;
      continue;
    }
    const { done, pending, errors } = classifyReceipts(batch, result.data ?? {});
    summary.ok += done.length - errors.length;
    summary.errors += errors.length;
    summary.pending += pending.length;
    // Receipt errors are attributed to the original sender in the log line.
    for (const e of errors) {
      const source = batch.find((t) => t.token === e.token)?.source ?? 'unknown';
      await handlePushErrors([e], source, 'receipt');
    }
    await Promise.all(done.map((t) => ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: t.PK, SK: t.SK } }))));
  }
  return summary;
}
