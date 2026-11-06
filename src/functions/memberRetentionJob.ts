import {
  DeleteObjectsCommand, GetObjectTaggingCommand, ListObjectsV2Command, ListObjectVersionsCommand, S3Client,
} from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { ARCHIVE_TABLE, logArchiveEvent, META_KEY } from '../lib/memberArchive';

// The only code that can delete a signed file, running as the only role the
// signed-forms bucket lets delete (incore-retention-job, signed_forms.tf).
//   - monthly: files archived 7+ years ago, re-checking the archived=true tag.
//   - DynamoDB stream: logs each row the archive table's TTL removed.
//   - purge_member: one test member's files and rows, with a dry run.

type Brand = 'incore' | 'forca';
type S3Object = { Key: string; VersionId?: string; Size?: number };

interface PurgeJob { job: 'purge_member'; memberId: string; brand: Brand; dryRun: boolean }
interface StreamEvent {
  Records: { dynamodb?: { OldImage?: Record<string, { S?: string }> } }[];
}

const s3 = new S3Client({});
const S3_DELETE_BATCH = 1000;
const signedBucket = (brand: Brand) => `${brand}-production-signed-forms`;
const UPLOADS_BUCKET = process.env.BUCKET_NAME as string;

async function listVersions(bucket: string, prefix: string): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const res = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
    for (const v of res.Versions ?? []) if (v.Key) out.push({ Key: v.Key, VersionId: v.VersionId, Size: v.Size });
    for (const m of res.DeleteMarkers ?? []) if (m.Key) out.push({ Key: m.Key, VersionId: m.VersionId, Size: 0 });
    keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
    versionMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return out;
}

async function deleteObjects(bucket: string, objects: S3Object[]): Promise<void> {
  for (let i = 0; i < objects.length; i += S3_DELETE_BATCH) {
    const res = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: objects.slice(i, i + S3_DELETE_BATCH).map(({ Key, VersionId }) => ({ Key, VersionId })), Quiet: true },
    }));
    if (res.Errors?.length) throw new Error(`S3 delete failed in ${bucket}: ${res.Errors[0].Code} ${res.Errors[0].Key}`);
  }
}

async function scanAll(params: ConstructorParameters<typeof ScanCommand>[0]): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey: lastKey }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function expireArchivedFiles(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = await scanAll({
    TableName: ARCHIVE_TABLE,
    FilterExpression: 'fileDeleteAfter <= :now',
    ExpressionAttributeValues: { ':now': now },
  });
  for (const row of due) {
    const { TagSet } = await s3.send(new GetObjectTaggingCommand({ Bucket: row.bucket, Key: row.key }));
    if (!TagSet?.some((t) => t.Key === 'archived' && t.Value === 'true')) {
      console.error(`[memberRetentionJob] skipped untagged file ${row.bucket}/${row.key}`);
      continue;
    }
    const versions = (await listVersions(row.bucket, row.key)).filter((v) => v.Key === row.key);
    await deleteObjects(row.bucket, versions);
    await logArchiveEvent({ event: 'auto_deleted', memberId: row.memberId, kind: row.kind, detail: 'file' });
    await ddb.send(new DeleteCommand({ TableName: ARCHIVE_TABLE, Key: { memberId: row.memberId, recordKey: row.recordKey } }));
  }
  console.log(`[memberRetentionJob] expired ${due.length} file(s)`);
}

async function logExpiredRows(event: StreamEvent): Promise<void> {
  for (const record of event.Records) {
    const image = record.dynamodb?.OldImage;
    const memberId = image?.memberId?.S;
    if (memberId) await logArchiveEvent({ event: 'auto_deleted', memberId, kind: image?.kind?.S ?? 'member', detail: 'record' });
  }
}

/** A test member, or leftovers with no live profile. A real archived member is refused. */
async function assertPurgeable(memberId: string, brand: Brand): Promise<void> {
  const [profile, meta] = await Promise.all([
    ddb.send(new GetCommand({ TableName: tableForBrand(brand), Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: ARCHIVE_TABLE, Key: { memberId, recordKey: META_KEY } })),
  ]);
  if (profile.Item && profile.Item.isTest !== true) throw new Error('not_a_test_member');
  if (meta.Item && meta.Item.isTest !== true) throw new Error('archived_member');
}

async function purgeMember({ memberId, brand, dryRun }: PurgeJob) {
  await assertPurgeable(memberId, brand);

  const signed = await listVersions(signedBucket(brand), `signed-forms/${memberId}/`);
  const uploads: S3Object[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: UPLOADS_BUCKET, ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Key?.includes(memberId)) uploads.push({ Key: o.Key, Size: o.Size });
    token = res.NextContinuationToken;
  } while (token);

  const table = tableForBrand(brand);
  const rows = (await scanAll({
    TableName: table,
    FilterExpression: 'contains(PK, :id) OR contains(SK, :id) OR userId = :id OR childId = :id OR childUid = :id OR memberId = :id',
    ExpressionAttributeValues: { ':id': memberId },
    ProjectionExpression: 'PK, SK',
  })).filter((r) => r.SK !== 'PROFILE');
  const archived = (await ddb.send(new QueryCommand({
    TableName: ARCHIVE_TABLE,
    KeyConditionExpression: 'memberId = :id',
    ExpressionAttributeValues: { ':id': memberId },
    ProjectionExpression: 'memberId, recordKey',
  }))).Items ?? [];

  const summary = {
    memberId,
    objects: [...signed, ...uploads].map((o) => ({ key: o.Key, versionId: o.VersionId, size: o.Size ?? 0 })),
    totalBytes: [...signed, ...uploads].reduce((sum, o) => sum + (o.Size ?? 0), 0),
    rows: rows.length,
    archiveRows: archived.length,
    dryRun,
  };
  if (dryRun) return summary;

  await deleteObjects(signedBucket(brand), signed);
  await deleteObjects(UPLOADS_BUCKET, uploads);
  await Promise.all(rows.map((r) => ddb.send(new DeleteCommand({ TableName: table, Key: { PK: r.PK, SK: r.SK } }))));
  await Promise.all(archived.map((r) => ddb.send(new DeleteCommand({ TableName: ARCHIVE_TABLE, Key: { memberId: r.memberId, recordKey: r.recordKey } }))));
  await logArchiveEvent({ event: 'test_member_purged', memberId, kind: 'member', detail: `${summary.objects.length} objects` });
  return summary;
}

export async function handler(event: StreamEvent | PurgeJob | Record<string, unknown>) {
  if ('Records' in event) return logExpiredRows(event as StreamEvent);
  if ((event as PurgeJob).job === 'purge_member') return purgeMember(event as PurgeJob);
  return expireArchivedFiles();
}
