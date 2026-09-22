import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import type { ProductItem } from '../lib/entities';

// GET or POST /getProducts?brand=incore|forca
// Auth: Cognito JWT (any signed-in member)
// Returns every product for one brand — the Store screen filters to
// is_public/assigned_to itself, the admin Membership manager filters to
// type==='subscription' itself, same as they did reading the whole
// Firestore collection before.
//
// brand picks which table to scan (see the FORCA data separation plan). An
// explicit ?brand= (sent by the admin Membership manager, from the
// Backoffice toggle) wins; otherwise this resolves the caller's own brand
// (the member-facing Store screen, which doesn't know/send one).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const requestedBrand = event.queryStringParameters?.brand;
  const brand = requestedBrand === 'forca' ? 'forca' as const
    : requestedBrand === 'incore' ? 'incore' as const
    : (await resolveMemberProfile(getUid(event)))?.profile.identity?.brand ?? 'incore';

  const res = await ddb.send(new ScanCommand({
    TableName: tableForBrand(brand),
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'PRODUCT#', ':metadata': 'METADATA' },
  }));

  const products = ((res.Items ?? []) as ProductItem[]).map((p) => ({
    id: p.PK.replace('PRODUCT#', ''),
    name: p.name ?? '',
    description: p.description ?? '',
    price: p.price ?? 0,
    sessions: p.sessions ?? 0,
    type: p.type,
    sessions_per_week: p.sessions_per_week,
    is_public: p.is_public ?? true,
    assigned_to: p.assigned_to ?? [],
    visibility: p.visibility,
    target_group_ids: p.target_group_ids ?? [],
    active: p.active ?? true,
    created_at: p.createdAt ?? null,
    productImageUrl: p.productImageUrl,
    monthlyLimit: p.monthlyLimit,
    weeklyLimit: p.weeklyLimit,
    allowedLegalCancellationsPerMonth: p.allowedLegalCancellationsPerMonth,
    endDate: p.expires_at ?? null,
    installments: p.installments,
    popular: p.popular ?? false,
    priority_book: p.priority_book ?? false,
    allowed_class_ids: p.allowed_class_ids ?? [],
  }));

  return json(200, { products });
}
