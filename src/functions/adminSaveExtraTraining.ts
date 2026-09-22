import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { ADMIN_UPLOAD_PREFIXES } from '../lib/adminConfig';
import type { ExtraTrainingItem } from '../lib/entities';

// POST /adminSaveExtraTraining
// Body: { id?: string, title: string, description?: string, category?: string,
//         contentType?: 'video' | 'pdf', fileKey?: string }
// Omit id to create (contentType/fileKey required then — upload the file
// first via adminGetS3UploadUrl.ts, under forca-extra-training/). Pass id to
// update; omit contentType/fileKey on an update that isn't replacing the
// file — getExtraTraining.ts only ever hands the client a presigned URL,
// never the raw key, so there's nothing for it to send back anyway.
// Auth: Cognito JWT, caller must be admin. FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; title?: unknown; description?: unknown; category?: unknown; contentType?: unknown; fileKey?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return json(400, { error: 'missing_title' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let createdBy = callerUid;
  let existing: ExtraTrainingItem | undefined;
  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXTRATRAINING#${existingId}`, SK: 'METADATA' } }));
    existing = existingRes.Item as ExtraTrainingItem | undefined;
    // A PutCommand replaces the whole item, so an update has to carry the
    // original createdAt/createdBy forward explicitly rather than omitting
    // them and hoping they survive.
    if (existing) {
      createdAt = existing.createdAt;
      createdBy = existing.createdBy;
    }
  }

  const rawFileKey = typeof body.fileKey === 'string' ? body.fileKey.trim() : '';
  const replacingFile = !!rawFileKey;

  let contentType: 'video' | 'pdf';
  let fileKey: string;
  if (replacingFile) {
    if (!ADMIN_UPLOAD_PREFIXES.some((prefix) => rawFileKey.startsWith(prefix))) return json(400, { error: 'invalid_file_key' });
    const bodyContentType = body.contentType === 'video' || body.contentType === 'pdf' ? body.contentType : null;
    if (!bodyContentType) return json(400, { error: 'invalid_content_type' });
    contentType = bodyContentType;
    fileKey = rawFileKey;
    // Swapping the file on an edit would otherwise orphan the old upload.
    if (existing?.fileKey && existing.fileKey !== fileKey) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: existing.fileKey })).catch(() => {});
    }
  } else if (existing) {
    contentType = existing.contentType;
    fileKey = existing.fileKey;
  } else {
    return json(400, { error: 'missing_file' });
  }

  const item: ExtraTrainingItem = {
    PK: `EXTRATRAINING#${id}`,
    SK: 'METADATA',
    title,
    ...(typeof body.description === 'string' && body.description.trim() ? { description: body.description.trim() } : {}),
    ...(typeof body.category === 'string' && body.category.trim() ? { category: body.category.trim() } : {}),
    contentType,
    fileKey,
    createdAt,
    createdBy,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id, title });
}
