import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET_NAME } from '../lib/s3';
import { json } from '../lib/http';
import { resizeStoragePhoto } from '../lib/profilePhoto';

// POST /adminBackfillResizeProfilePhotos
// Auth: fixed secret header (x-backfill-secret), NOT Cognito — ported as-is
// from the original, including the secret being hardcoded in source rather
// than pulled from Secrets Manager. Flagging that as worth fixing, not
// changing it silently. One-time maintenance op, not called from any client.
const BACKFILL_SECRET = 'incore-photo-backfill-2026-07';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const headerSecret = event.headers?.['x-backfill-secret'];
  if (headerSecret !== BACKFILL_SECRET) return json(401, { error: 'unauthorized' });

  const results: { path: string; resized: boolean; beforeBytes: number; afterBytes: number; error?: string }[] = [];
  let scanned = 0;
  let continuationToken: string | undefined;

  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: 'profile_photos/',
      ContinuationToken: continuationToken,
    }));

    for (const obj of listRes.Contents ?? []) {
      if (!obj.Key) continue;
      scanned++;
      try {
        const headRes = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key }));
        if (headRes.Metadata?.resized === 'true') continue; // already done

        const result = await resizeStoragePhoto(obj.Key);
        results.push({ path: obj.Key, ...result });
      } catch (err: any) {
        results.push({
          path: obj.Key, resized: false, beforeBytes: 0, afterBytes: 0,
          error: err instanceof Error ? err.message : 'failed',
        });
      }
    }

    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);

  const totalBefore = results.reduce((sum, r) => sum + r.beforeBytes, 0);
  const totalAfter = results.reduce((sum, r) => sum + r.afterBytes, 0);
  console.log(`[adminBackfillResizeProfilePhotos] scanned=${scanned} touched=${results.length} ${totalBefore}b -> ${totalAfter}b`);

  return json(200, {
    success: true,
    scanned,
    touched: results.length,
    resizedCount: results.filter((r) => r.resized).length,
    totalBefore,
    totalAfter,
    results,
  });
}
