import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ForcaSubscriptionProductItem, GroupItem } from '../lib/entities';

// GET or POST /adminListForcaSubscriptionProducts
// Auth: Cognito JWT, caller must be admin
// Every subscription product, draft and published — the Backoffice list
// view. groupName is resolved live (not denormalized) so a later group
// rename is reflected immediately.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const [productsRes, groupsRes] = await Promise.all([
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'FORCASUBPRODUCT#', ':metadata': 'METADATA' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
    })),
  ]);

  const groupNameById = new Map<string, string>(
    ((groupsRes.Items ?? []) as (GroupItem & { PK: string })[]).map((g) => [g.PK.replace('GROUP#', ''), g.name]),
  );

  const rawItems = (productsRes.Items ?? []) as (ForcaSubscriptionProductItem & { PK: string })[];
  const products = rawItems.map((p) => ({
    id: p.PK.replace('FORCASUBPRODUCT#', ''),
    name: p.name,
    description: p.description ?? null,
    price: p.price,
    groupId: p.groupId,
    groupName: groupNameById.get(p.groupId) ?? null,
    visibility: p.visibility,
    targetParentUids: p.targetParentUids ?? [],
    active: p.active,
    createdAt: p.createdAt,
  }));

  products.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return json(200, { products });
}
