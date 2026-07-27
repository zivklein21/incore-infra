import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET /adminGetS3ObjectMetadata?key=product-images/foo.jpg
// Auth: Cognito JWT, caller must be admin
//
// Powers the Assets Manager's file-detail panel: content type/size/custom
// metadata plus a presigned GET URL for preview/copy — admins can read any
// key in the bucket, unlike getFileUrl.ts's own-uid-or-admin check (that
// endpoint still works fine for admins too; this one skips the ownership
// branch entirely and adds the HeadObject metadata the Assets screen needs).
const PREVIEW_URL_EXPIRY_SECONDS = 900;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const key = event.queryStringParameters?.key;
  if (!key) return json(400, { error: 'missing_key' });

  try {
    const [head, url] = await Promise.all([
      s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key })),
      getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: PREVIEW_URL_EXPIRY_SECONDS }),
    ]);

    return json(200, {
      key,
      size: head.ContentLength ?? 0,
      contentType: head.ContentType ?? null,
      lastModified: head.LastModified?.toISOString() ?? null,
      etag: head.ETag ?? null,
      metadata: head.Metadata ?? {},
      url,
    });
  } catch (err: any) {
    if (err?.name === 'NotFound') return json(404, { error: 'not_found' });
    throw err;
  }
}
