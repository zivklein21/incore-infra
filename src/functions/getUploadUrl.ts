import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';

// POST /getUploadUrl
// Auth: Cognito JWT (any signed-in member)
// Body: { storagePath: string, contentType: string }
//
// Returns a short-lived pre-signed PUT URL — the client uploads the file
// bytes directly to S3 with it (no Lambda payload-size limit, no double-hop
// bandwidth cost). incore_uploads (s3.tf) is fully private
// (block_public_acls / restrict_public_buckets), so nothing is readable
// without a separate pre-signed GET from getFileUrl.ts.
//
// storagePath must be scoped under the caller's own uid (one of the
// existing path conventions the client already used against Firebase
// Storage — profile_photos/<uid>, health-declarations/<uid>/..., etc.) so
// one member can't overwrite or squat on another member's files. Admins get
// no special write access here; there's no legitimate reason for an admin
// to upload into another member's path directly.
const ALLOWED_PREFIXES = ['profile_photos/', 'health-declarations/', 'doctor-approvals/', 'signatures/', 'medical-clearances/'];
const UPLOAD_URL_EXPIRY_SECONDS = 300;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { storagePath?: unknown; contentType?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  const contentType = typeof body.contentType === 'string' && body.contentType ? body.contentType : 'application/octet-stream';

  const matchesAllowedPrefix = ALLOWED_PREFIXES.some((prefix) => storagePath.startsWith(prefix));
  const pathContainsOwnUid = storagePath.includes(uid);
  if (!storagePath || !matchesAllowedPrefix || !pathContainsOwnUid) {
    return json(400, { error: 'invalid_storage_path' });
  }

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET_NAME, Key: storagePath, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
  );

  return json(200, { uploadUrl, storagePath });
}
