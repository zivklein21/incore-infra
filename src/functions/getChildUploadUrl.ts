import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';

// POST /getChildUploadUrl
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
// Body: { childUid: string, storagePath: string, contentType: string }
//
// getUploadUrl.ts's own ownership check (storagePath must contain the
// caller's own uid) can't authorize this — the parent stays in her own
// session (no ActiveProfileContext.switchToChild) but needs to write into
// her daughter's medical-clearances/<childUid>/... path. Rather than loosen
// that invariant for every upload use case, this is a narrowly-scoped
// separate endpoint: family-link-authorized, and restricted to exactly the
// one prefix a parent legitimately needs to write into on her child's
// behalf. See saveChildMedicalClearance.ts for the write that follows.
const UPLOAD_URL_EXPIRY_SECONDS = 300;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { childUid?: unknown; storagePath?: unknown; contentType?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';
  const contentType = typeof body.contentType === 'string' && body.contentType ? body.contentType : 'application/octet-stream';
  if (!storagePath || !storagePath.startsWith('medical-clearances/') || !storagePath.includes(childUid)) {
    return json(400, { error: 'invalid_storage_path' });
  }

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET_NAME, Key: storagePath, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
  );

  return json(200, { uploadUrl, storagePath });
}
