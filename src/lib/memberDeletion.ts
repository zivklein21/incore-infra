import {
  DeleteObjectsCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectTaggingCommand,
} from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { deleteCognitoUser } from './cognito';
import { ddb, FORCA_TABLE_NAME, TABLE_NAME, tableForBrand } from './dynamo';
import type { ClassItem, MemberProfileItem, RegistrationItem } from './entities';
import { signedFormsBucket } from './formTemplates/signedPdf';
import { ARCHIVE_TABLE, classifyRow, deleteAfterFor, META_KEY, scrubForArchive, type RetainedKind } from './memberArchive';
import { BUCKET_NAME, s3 } from './s3';

type Brand = 'incore' | 'forca';
type Key = { PK: string; SK: string };
type Row = Key & Record<string, unknown>;
interface ArchiveContext { memberId: string; brand: Brand; isTest: boolean; archivedAt: string; birthday: unknown }


export interface DeletionVerification {
  activeSubscriptions: number;
  cardTokens: number;
  /** The app charges saved tokens itself and never creates a standing order at HYP. */
  hypStandingOrders: 'none_held';
}

const DELETE_CONCURRENCY = 25;
const S3_DELETE_BATCH = 1000;
// Everything else a member uploads is medical or signature evidence, and is kept.
const DELETED_UPLOAD_PREFIX = 'profile_photos/';

// Deleting a member, in order: mark them pending, stop every charge and prove
// it, then remove what isn't needed and move what must be kept to the archive
// table and cheaper storage. Each step can run twice, so a failed delete is
// finished by pressing delete again; until then the member stays "pending" and
// can't be charged. A deleted parent's child stays, uncharged. Accounts marked
// isTest keep nothing: their signed files go through the retention job, the
// only role that can delete them (signed_forms.tf).

async function scanAll<T>(params: ConstructorParameters<typeof ScanCommand>[0]): Promise<T[]> {
  const items: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey: lastKey }));
    items.push(...(res.Items ?? []) as T[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ─── Charging ────────────────────────────────────────────────────────────────

/** Every agreement this member is on or pays for, by a scan so a removed family link can't hide one. */
function findAgreements(brand: Brand, memberId: string): Promise<Row[]> {
  return scanAll<Row>({
    TableName: tableForBrand(brand),
    FilterExpression: 'begins_with(PK, :prefix) AND (userId = :id OR payerUid = :id)',
    ExpressionAttributeValues: { ':prefix': brand === 'forca' ? 'FORCAAGREEMENT#' : 'AGREEMENT#', ':id': memberId },
  });
}

async function stopCharging(brand: Brand, memberId: string): Promise<void> {
  const table = tableForBrand(brand);
  const agreements = await findAgreements(brand, memberId);
  await Promise.all(agreements.map((a) => ddb.send(new UpdateCommand({
    TableName: table,
    Key: { PK: a.PK, SK: a.SK },
    // `token` is a DynamoDB reserved keyword.
    UpdateExpression: 'SET #status = :cancelled, #token = :empty, tokenExpiryMonth = :zero, tokenExpiryYear = :zero, updatedAt = :now REMOVE GSI3PK, GSI3SK, nextChargeDate',
    ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
    ExpressionAttributeValues: { ':cancelled': 'cancelled', ':empty': '', ':zero': 0, ':now': new Date().toISOString() },
  }))));
}

async function removeProfileCard(table: string, profileKey: Key): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: profileKey,
    ConditionExpression: 'attribute_exists(PK)',
    UpdateExpression: 'REMOVE payment',
  })).catch((err) => {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  });
}

export async function verifyNoCharging(brand: Brand, memberId: string): Promise<DeletionVerification> {
  const table = tableForBrand(brand);
  const [agreements, profileRes] = await Promise.all([
    findAgreements(brand, memberId),
    ddb.send(new GetCommand({ TableName: table, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } })),
  ]);
  const profile = profileRes.Item as MemberProfileItem | undefined;
  return {
    activeSubscriptions: agreements.filter((a) => a.status === 'active' || a.status === 'frozen').length,
    cardTokens: agreements.filter((a) => !!a.token).length + (profile?.payment?.hypToken ? 1 : 0),
    hypStandingOrders: 'none_held',
  };
}

async function queryAllRegs(table: string, memberId: string): Promise<RegistrationItem[]> {
  const items: RegistrationItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []) as RegistrationItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// ─── Classes ─────────────────────────────────────────────────────────────────

/** What a class must change to forget this member; null when it never knew them. */
export function classCleanup(
  brand: Brand,
  cls: Pick<ClassItem, 'waitlist' | 'allowedMemberIds'>,
  memberId: string,
  reg?: Pick<RegistrationItem, 'status' | 'consumedFrom'>,
): { waitlist?: ClassItem['waitlist']; allowedMemberIds?: string[]; attendees: number; capacity: number } | null {
  const inWaitlist = (cls.waitlist ?? []).some((e) => e.member === memberId);
  const inAllowed = (cls.allowedMemberIds ?? []).includes(memberId);
  const attendees = reg?.status === 'REGISTERED' ? -1 : 0;
  // A FORCA session's capacity is its roster, so each auto-registered trainee
  // added a seat (sessionInstance.ts). An INCORE class has a fixed capacity.
  const capacity = brand === 'forca' && reg?.consumedFrom === 'FORCA_AUTO' ? -1 : 0;
  if (!inWaitlist && !inAllowed && !attendees && !capacity) return null;
  return {
    ...(inWaitlist ? { waitlist: (cls.waitlist ?? []).filter((e) => e.member !== memberId) } : {}),
    ...(inAllowed ? { allowedMemberIds: (cls.allowedMemberIds ?? []).filter((id) => id !== memberId) } : {}),
    attendees,
    capacity,
  };
}

/** What's kept of one past class. */
export function attendanceRecord(cls: Partial<ClassItem>, reg: Partial<RegistrationItem>) {
  return {
    date: cls.date,
    session: cls.className ?? '',
    location: cls.location ?? null,
    coach: cls.coachName ?? null,
    attendance: reg.actualAttendance ?? null,
    declared: reg.declaredAttendance ?? null,
  };
}

// Future classes forget the member; past ones keep their counts, and the
// attendance moves to the archive.
export async function removeFromClasses(table: string, ctx: ArchiveContext): Promise<void> {
  const { memberId } = ctx;
  const [regs, classes] = await Promise.all([
    queryAllRegs(table, memberId),
    scanAll<ClassItem>({
      TableName: table,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA' },
    }),
  ]);
  const regByClass = new Map(regs.map((r) => [`CLASS#${r.classId}`, r]));
  const nowIso = new Date().toISOString();

  await Promise.all(classes.map(async (cls) => {
    const reg = regByClass.get(cls.PK);
    if (cls.date < nowIso) {
      if (!reg) return;
      if (!ctx.isTest) {
        await ddb.send(new PutCommand({
          TableName: ARCHIVE_TABLE,
          Item: {
            memberId, recordKey: `ROW#${reg.PK}#${reg.SK}`, brand: ctx.brand, kind: 'attendance',
            item: attendanceRecord(cls, reg), archivedAt: ctx.archivedAt, deleteAfter: deleteAfterFor(ctx.archivedAt, ctx.birthday),
          },
        }));
      }
      await ddb.send(new DeleteCommand({ TableName: table, Key: { PK: reg.PK, SK: reg.SK } }));
      return;
    }

    const change = classCleanup(ctx.brand, cls, memberId, reg);
    if (change) {
      const sets: string[] = [];
      const adds: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      if (change.waitlist) { sets.push('waitlist = :waitlist'); values[':waitlist'] = change.waitlist; }
      if (change.allowedMemberIds) { sets.push('allowedMemberIds = :ids'); values[':ids'] = change.allowedMemberIds; }
      if (change.attendees) { adds.push('currentAttendeesCount :attendees'); values[':attendees'] = change.attendees; }
      if (change.capacity) {
        // capacity is a DynamoDB reserved keyword.
        adds.push('#capacity :capacity');
        names['#capacity'] = 'capacity';
        values[':capacity'] = change.capacity;
      }
      await ddb.send(new UpdateCommand({
        TableName: table,
        Key: { PK: cls.PK, SK: cls.SK },
        UpdateExpression: [sets.length ? `SET ${sets.join(', ')}` : '', adds.length ? `ADD ${adds.join(', ')}` : ''].filter(Boolean).join(' '),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
      }));
    }
    // Straight after the count changes, so a re-run can't subtract it twice.
    if (reg) await ddb.send(new DeleteCommand({ TableName: table, Key: { PK: reg.PK, SK: reg.SK } }));
  }));
}

// ─── Files ───────────────────────────────────────────────────────────────────

async function deleteS3Keys(bucket: string, objects: { Key: string }[]): Promise<void> {
  for (let i = 0; i < objects.length; i += S3_DELETE_BATCH) {
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: objects.slice(i, i + S3_DELETE_BATCH), Quiet: true },
    }));
    if (res.Errors?.length) throw new Error(`S3 delete failed in ${bucket}: ${res.Errors[0].Code} ${res.Errors[0].Key}`);
  }
}

async function tag(bucket: string, Key: string, VersionId?: string): Promise<void> {
  await s3.send(new PutObjectTaggingCommand({
    Bucket: bucket, Key, VersionId, Tagging: { TagSet: [{ Key: 'archived', Value: 'true' }] },
  }));
}

async function putFileRecord(ctx: ArchiveContext, bucket: string, key: string, kind: RetainedKind): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: ARCHIVE_TABLE,
    Item: {
      memberId: ctx.memberId, recordKey: `FILE#${bucket}#${key}`, brand: ctx.brand, kind, bucket, key,
      archivedAt: ctx.archivedAt, fileDeleteAfter: deleteAfterFor(ctx.archivedAt, ctx.birthday),
    },
  }));
}

// Upload paths vary by feature but all contain the member's uid (getUploadUrl.ts).
async function handleUploads(ctx: ArchiveContext): Promise<void> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Key?.includes(ctx.memberId)) keys.push(o.Key);
    token = res.NextContinuationToken;
  } while (token);

  const retained = ctx.isTest ? [] : keys.filter((k) => !k.startsWith(DELETED_UPLOAD_PREFIX));
  await deleteS3Keys(BUCKET_NAME, keys.filter((k) => !retained.includes(k)).map((Key) => ({ Key })));
  for (const key of retained) {
    await tag(BUCKET_NAME, key);
    await putFileRecord(ctx, BUCKET_NAME, key, 'medical');
  }
}

async function archiveSignedFiles(ctx: ArchiveContext): Promise<void> {
  const bucket = signedFormsBucket(ctx.brand);
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const res = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket, Prefix: `signed-forms/${ctx.memberId}/`, KeyMarker: keyMarker, VersionIdMarker: versionMarker,
    }));
    for (const v of res.Versions ?? []) {
      if (!v.Key) continue;
      await tag(bucket, v.Key, v.VersionId);
      if (v.IsLatest) await putFileRecord(ctx, bucket, v.Key, 'signed_form');
    }
    keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
    versionMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
  } while (keyMarker);
}

/** This role can't delete signed files; only the retention job's can. */
async function purgeTestMember(ctx: ArchiveContext): Promise<void> {
  // Runtime-provided package, loaded here so tests can import this file.
  const { InvokeCommand, LambdaClient } = await import('@aws-sdk/client-lambda');
  const res = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: process.env.RETENTION_JOB_FUNCTION,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ job: 'purge_member', memberId: ctx.memberId, brand: ctx.brand, dryRun: false })),
  }));
  if (res.FunctionError) throw new Error(`purge failed: ${Buffer.from(res.Payload ?? []).toString()}`);
}

// ─── Rows ────────────────────────────────────────────────────────────────────

async function deleteRows(table: string, keys: Key[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    await Promise.all(keys.slice(i, i + DELETE_CONCURRENCY).map(({ PK, SK }) => ddb.send(new DeleteCommand({ TableName: table, Key: { PK, SK } }))));
  }
}

async function archiveRow(ctx: ArchiveContext, row: Row, kind: RetainedKind): Promise<void> {
  // A fixed key per row: writing it again on a re-run changes nothing.
  await ddb.send(new PutCommand({
    TableName: ARCHIVE_TABLE,
    Item: {
      memberId: ctx.memberId,
      recordKey: `ROW#${row.PK}#${row.SK}`,
      brand: ctx.brand,
      kind,
      item: scrubForArchive(row),
      archivedAt: ctx.archivedAt,
      deleteAfter: deleteAfterFor(ctx.archivedAt, ctx.birthday),
    },
  }));
}

// Every row carrying the id, whatever its type, so a new kind of member data
// is covered without changing this. Ids are UUIDs: they can't match by chance.
async function handleRows(table: string, ctx: ArchiveContext, profileKey: Key): Promise<void> {
  const rows = await scanAll<Row>({
    TableName: table,
    FilterExpression: 'contains(PK, :id) OR contains(SK, :id) OR userId = :id OR childId = :id OR childUid = :id OR memberId = :id',
    ExpressionAttributeValues: { ':id': ctx.memberId },
  });
  const others = rows.filter((r) => r.PK !== profileKey.PK || r.SK !== profileKey.SK);
  if (!ctx.isTest) {
    for (const row of others) {
      const kind = classifyRow(row);
      if (kind) await archiveRow(ctx, row, kind);
    }
  }
  await deleteRows(table, others);
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function deleteMemberData(
  memberId: string, brand: Brand, deletedBy: string,
): Promise<{ found: boolean; verification?: DeletionVerification }> {
  const table = tableForBrand(brand);
  const profileKey = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const metaKey = { memberId, recordKey: META_KEY };

  const [profileRes, metaRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: table, Key: profileKey })),
    ddb.send(new GetCommand({ TableName: ARCHIVE_TABLE, Key: metaKey })),
  ]);
  const profile = profileRes.Item as (MemberProfileItem & Row) | undefined;
  const meta = metaRes.Item;
  if (!profile && !meta) return { found: false };

  const birthday = profile?.identity?.birthday ?? profile?.birthday ?? meta?.birthday;
  const isTest = profile?.isTest === true || meta?.isTest === true;
  const name = profile?.identity?.name ?? profile?.name ?? meta?.name ?? '';
  const archivedAt = meta?.startedAt ?? new Date().toISOString();
  const ctx: ArchiveContext = { memberId, brand, isTest, archivedAt, birthday };

  await ddb.send(new PutCommand({
    TableName: ARCHIVE_TABLE,
    Item: { ...metaKey, brand, name, birthday, isTest, status: 'deletion_pending', deletedBy, startedAt: archivedAt },
  }));
  if (profile) {
    await ddb.send(new UpdateCommand({ TableName: table, Key: profileKey, UpdateExpression: 'SET deletionPending = :true', ExpressionAttributeValues: { ':true': true } }));
  }

  await stopCharging(brand, memberId);
  await removeProfileCard(table, profileKey);
  const stopped = await verifyNoCharging(brand, memberId);
  if (stopped.activeSubscriptions || stopped.cardTokens) throw new Error(`charging_not_stopped: ${JSON.stringify(stopped)}`);

  await removeFromClasses(table, ctx);
  await handleUploads(ctx);
  if (isTest) await purgeTestMember(ctx);
  else await archiveSignedFiles(ctx);
  await handleRows(table, ctx, profileKey);

  if (profile) {
    if (!isTest) await archiveRow(ctx, profile, 'medical');
    await ddb.send(new DeleteCommand({ TableName: table, Key: profileKey }));
  }

  // One login can serve both brands: keep it if the other brand still uses it.
  const other = await ddb.send(new GetCommand({ TableName: brand === 'forca' ? TABLE_NAME : FORCA_TABLE_NAME, Key: profileKey }));
  if (!other.Item) await deleteCognitoUser(memberId);

  const verification = await verifyNoCharging(brand, memberId);
  if (verification.activeSubscriptions || verification.cardTokens) throw new Error(`charging_not_stopped: ${JSON.stringify(verification)}`);

  if (isTest) {
    await ddb.send(new DeleteCommand({ TableName: ARCHIVE_TABLE, Key: metaKey }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: ARCHIVE_TABLE,
      Key: metaKey,
      UpdateExpression: 'SET #status = :deleted, deletedAt = :now, verification = :v, deleteAfter = :after',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':deleted': 'deleted', ':now': new Date().toISOString(), ':v': verification, ':after': deleteAfterFor(archivedAt, birthday) },
    }));
  }
  return { found: true, verification };
}

