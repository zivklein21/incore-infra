import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MerchProductItem } from '../lib/entities';

const IMAGE_URL_EXPIRY_SECONDS = 900;

// GET or POST /adminListMerchProducts
// Auth: Cognito JWT, caller must be admin
// Every merch product, draft and published — the Backoffice list view.
// imageKeys resolved to short-lived signed URLs, same convention as
// getExtraTraining.ts; raw S3 keys never leave this function.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'MERCHPRODUCT#', ':metadata': 'METADATA' },
  }));
  const rawItems = (res.Items ?? []) as (MerchProductItem & { PK: string })[];

  const products = await Promise.all(rawItems.map(async (p) => ({
    id: p.PK.replace('MERCHPRODUCT#', ''),
    name: p.name,
    description: p.description ?? null,
    price: p.price,
    active: p.active,
    variants: p.variants,
    // Only exposed to admin (never to getForcaMerchProducts.ts's client
    // response) — needed so editing a product without touching its photos
    // can resend the same keys unchanged instead of re-uploading.
    imageKeys: p.imageKeys ?? [],
    imageUrls: await Promise.all((p.imageKeys ?? []).map((key) =>
      getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: IMAGE_URL_EXPIRY_SECONDS }).catch(() => null),
    )).then((urls) => urls.filter((u): u is string => !!u)),
    createdAt: p.createdAt,
  })));

  products.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json(200, { products });
}
