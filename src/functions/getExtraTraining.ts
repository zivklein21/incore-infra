import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { json } from '../lib/http';
import type { ExtraTrainingItem } from '../lib/entities';

// GET or POST /getExtraTraining
// Auth: Cognito JWT (any signed-in member) — this is trainee-facing content,
// not admin-only; every FORCA trainee can browse/watch/download it.
// FORCA-only. Longer-than-usual presign (1 hour, vs. the 900s most of the
// app uses for photos/PDFs) since a video is meant to be watched start to
// finish, not just glanced at.
const FILE_URL_EXPIRY_SECONDS = 3600;

export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'EXTRATRAINING#', ':metadata': 'METADATA' },
  }));
  const rawItems = (res.Items ?? []) as ExtraTrainingItem[];

  const items = await Promise.all(rawItems.map(async (i) => ({
    id: i.PK.replace('EXTRATRAINING#', ''),
    title: i.title ?? '',
    description: i.description ?? null,
    category: i.category ?? null,
    contentType: i.contentType,
    fileUrl: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: i.fileKey }), { expiresIn: FILE_URL_EXPIRY_SECONDS })
      .catch(() => null),
    createdAt: i.createdAt,
  })));

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json(200, { items });
}
