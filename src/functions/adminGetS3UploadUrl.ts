import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { ADMIN_UPLOAD_PREFIXES } from '../lib/adminConfig';

// POST /adminGetS3UploadUrl
// Auth: Cognito JWT, caller must be admin
// Body: { storagePath: string, contentType: string }
//
// Separate from getUploadUrl.ts because that endpoint requires the path to
// contain the caller's own uid (member-owned uploads); admin-authored
// assets like a product photo have no natural "owner" uid, so this checks
// against ADMIN_UPLOAD_PREFIXES (adminConfig.ts) instead.
const UPLOAD_URL_EXPIRY_SECONDS = 300;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { storagePath?: unknown; contentType?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  const contentType = typeof body.contentType === 'string' && body.contentType ? body.contentType : 'application/octet-stream';

  if (!storagePath || !ADMIN_UPLOAD_PREFIXES.some((prefix) => storagePath.startsWith(prefix))) {
    return json(400, { error: 'invalid_storage_path' });
  }

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET_NAME, Key: storagePath, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
  );

  return json(200, { uploadUrl, storagePath });
}
