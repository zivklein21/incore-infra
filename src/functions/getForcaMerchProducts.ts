import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { json } from '../lib/http';
import type { MerchProductItem } from '../lib/entities';

const IMAGE_URL_EXPIRY_SECONDS = 900;

// GET or POST /getForcaMerchProducts
// Auth: Cognito JWT (any signed-in FORCA member) — this is the Shop tab's
// own endpoint, trainee-facing. Only active:true products are returned;
// draft products stay admin-only (see adminListMerchProducts.ts). Exact
// stock counts are admin-only too — a trainee only ever learns in-stock vs
// out-of-stock (inStock), never the number, and that's enforced here
// server-side rather than left to the client UI to hide.
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND active = :active',
    ExpressionAttributeValues: { ':prefix': 'MERCHPRODUCT#', ':metadata': 'METADATA', ':active': true },
  }));
  const rawItems = (res.Items ?? []) as (MerchProductItem & { PK: string })[];

  const products = await Promise.all(rawItems.map(async (p) => ({
    id: p.PK.replace('MERCHPRODUCT#', ''),
    name: p.name,
    description: p.description ?? null,
    price: p.price,
    variants: p.variants.map((v) => ({ id: v.id, label: v.label, inStock: v.stock > 0 })),
    imageUrls: await Promise.all((p.imageKeys ?? []).map((key) =>
      getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: IMAGE_URL_EXPIRY_SECONDS }).catch(() => null),
    )).then((urls) => urls.filter((u): u is string => !!u)),
  })));

  products.sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { products });
}
