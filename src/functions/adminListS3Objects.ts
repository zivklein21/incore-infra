import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET /adminListS3Objects?prefix=product-images/&continuationToken=
// Auth: Cognito JWT, caller must be admin
//
// Folder-style browsing of incore-production-uploads via Delimiter='/':
// CommonPrefixes come back as pseudo-folders, Contents as files directly
// under the given prefix — the same trick the AWS console's S3 browser
// uses, since S3 has no real directory concept.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const q = event.queryStringParameters ?? {};

  const res = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
    Prefix: q.prefix || undefined,
    Delimiter: '/',
    ContinuationToken: q.continuationToken || undefined,
    MaxKeys: 100,
  }));

  const folders = (res.CommonPrefixes ?? []).map((p) => p.Prefix).filter((p): p is string => !!p);
  const files = (res.Contents ?? [])
    .filter((obj) => obj.Key && obj.Key !== q.prefix) // exclude the "directory marker" object itself
    .map((obj) => ({
      key: obj.Key as string,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString() ?? null,
      etag: obj.ETag ?? null,
    }));

  return json(200, {
    folders,
    files,
    nextContinuationToken: res.IsTruncated ? res.NextContinuationToken ?? null : null,
  });
}
