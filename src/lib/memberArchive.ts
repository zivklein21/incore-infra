import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isAdmin } from './auth';
import { ddb } from './dynamo';
import { getUid, json } from './http';
import { s3 } from './s3';

// What's kept of a deleted member (see memberDeletion.ts): one row per member
// (META) plus one per retained record or file, keyed by member id, in a table
// on the cheaper Standard-IA class. Everything goes after deleteAfterFor():
// rows through the table's TTL on deleteAfter, files through
// memberRetentionJob.ts. File rows use fileDeleteAfter instead, so TTL can't
// remove the row the job needs to find the file.

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

export const ARCHIVE_TABLE = process.env.ARCHIVE_TABLE_NAME as string;
export const META_KEY = 'META';
const AUDIT_LOG_ID = 'AUDIT_LOG';

export type RetainedKind = 'signed_form' | 'photo_consent' | 'signature_audit' | 'payment' | 'medical' | 'attendance';

const FILE_URL_TTL_SECONDS = 300;
const RETENTION_YEARS = 7;
const ADULT_AGE = 18;

/** Which retained category a table row belongs to; null means it gets deleted. */
export function classifyRow(row: { PK: string; SK: string }): RetainedKind | null {
  const { PK, SK } = row;
  if (PK.startsWith('FORMSUB#')) return 'signed_form';
  if (PK.startsWith('PHOTOCONSENT#')) return 'photo_consent';
  if (PK === 'FORM_AUDIT') return 'signature_audit';
  if (/^(FORCASUBORDER|MERCHORDER|ORDER|FORCAAGREEMENT|AGREEMENT)#/.test(PK)) return 'payment';
  if (/^(FORCASUBORDER|MERCHORDER|ORDER)#/.test(SK)) return 'payment';
  return null;
}

const SECRET_KEY = /token/i;
const DROPPED_KEYS = new Set(['payment', 'device', 'photoKey', 'emergencyContact', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'GSI3PK', 'GSI3SK']);

/** A copy with no card or push tokens at any depth, and no app-only fields. */
export function scrubForArchive<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubForArchive) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!SECRET_KEY.test(key) && !DROPPED_KEYS.has(key)) out[key] = scrubForArchive(v);
  }
  return out as T;
}

const addYears = (date: Date, years: number) => {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
};

/**
 * Epoch seconds for the table's TTL: 7 years after archiving, or 7 years after
 * the member's 18th birthday if that's later. An adult's is always the former.
 */
export function deleteAfterFor(archivedAt: string, birthday?: unknown): number {
  const standard = addYears(new Date(archivedAt), RETENTION_YEARS).getTime();
  const born = typeof birthday === 'string' || typeof birthday === 'number' ? new Date(birthday).getTime() : NaN;
  const minor = Number.isNaN(born) ? 0 : addYears(new Date(born), ADULT_AGE + RETENTION_YEARS).getTime();
  return Math.floor(Math.max(standard, minor) / 1000);
}

/** Who and what, for automatic deletions and test-flag changes. These rows never expire. */
export async function logArchiveEvent(entry: { event: string; memberId: string; kind: string; detail?: string; by?: string }): Promise<void> {
  const at = new Date().toISOString();
  console.log('[memberArchive]', JSON.stringify({ ...entry, at }));
  await ddb.send(new PutCommand({
    TableName: ARCHIVE_TABLE,
    Item: { memberId: AUDIT_LOG_ID, recordKey: `${at}#${randomUUID()}`, at, event: entry.event, targetMemberId: entry.memberId, kind: entry.kind, detail: entry.detail, by: entry.by },
  }));
}

async function scanArchive(): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: ARCHIVE_TABLE, ExclusiveStartKey: lastKey }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

const deleteAtOf = (r: Record<string, any>): string =>
  new Date(Number(r.deleteAfter ?? r.fileDeleteAfter) * 1000).toISOString();

const recordTitle = (r: Record<string, any>): string =>
  r.item?.title ?? r.item?.session ?? r.item?.productName ?? r.item?.templateId ?? String(r.key ?? r.recordKey).split('/').pop() ?? '';

// GET /adminListDeletedMembers?brand=incore|forca
export async function adminListDeletedMembers(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' : 'incore';
  const rows = (await scanArchive()).filter((r) => r.brand === brand);
  const metas = rows.filter((r) => r.recordKey === META_KEY);
  const scheduled = new Map<string, { memberId: string; name: string; deleteAt: string; counts: Record<string, number> }>();
  for (const r of rows) {
    if (r.recordKey === META_KEY) continue;
    const entry = scheduled.get(r.memberId) ?? {
      memberId: r.memberId,
      name: metas.find((m) => m.memberId === r.memberId)?.name ?? '',
      deleteAt: deleteAtOf(r),
      counts: {} as Record<string, number>,
    };
    const kind = String(r.kind);
    entry.counts[kind] = (entry.counts[kind] ?? 0) + 1;
    scheduled.set(r.memberId, entry);
  }
  return json(200, {
    members: metas
      .map((m) => ({ memberId: m.memberId, name: m.name, status: m.status, deletedAt: m.deletedAt ?? null, deletedBy: m.deletedBy }))
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt))),
    scheduledForDeletion: [...scheduled.values()].sort((a, b) => a.deleteAt.localeCompare(b.deleteAt)),
  });
}

// GET /adminGetDeletedMember?memberId=
export async function adminGetDeletedMember(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const memberId = event.queryStringParameters?.memberId ?? '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const res = await ddb.send(new QueryCommand({
    TableName: ARCHIVE_TABLE,
    KeyConditionExpression: 'memberId = :id',
    ExpressionAttributeValues: { ':id': memberId },
  }));
  const rows = res.Items ?? [];
  const meta = rows.find((r) => r.recordKey === META_KEY);
  if (!meta) return json(404, { error: 'not_found' });
  return json(200, {
    member: { memberId, name: meta.name, status: meta.status, deletedAt: meta.deletedAt ?? null, verification: meta.verification ?? null },
    records: rows.filter((r) => r.recordKey !== META_KEY).map((r) => ({
      recordKey: r.recordKey,
      kind: r.kind,
      title: recordTitle(r),
      isFile: String(r.recordKey).startsWith('FILE#'),
      deleteAt: deleteAtOf(r),
    })),
  });
}

// GET /adminGetArchivedFileUrl?memberId=&recordKey=
export async function adminGetArchivedFileUrl(event: Event): Promise<Result> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });
  const { memberId = '', recordKey = '' } = event.queryStringParameters ?? {};
  if (!memberId || !recordKey.startsWith('FILE#')) return json(400, { error: 'invalid_argument' });
  const res = await ddb.send(new GetCommand({ TableName: ARCHIVE_TABLE, Key: { memberId, recordKey } }));
  if (!res.Item) return json(404, { error: 'not_found' });
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: res.Item.bucket, Key: res.Item.key }), { expiresIn: FILE_URL_TTL_SECONDS });
  return json(200, { url });
}
