import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { deriveMemberName, type FamilyLinkItem, type ForcaSubscriptionProductItem, type GroupItem, type MemberProfileItem } from '../lib/entities';

// ANY /getForcaSubscriptionProductsForParent
// Auth: Cognito JWT — any authenticated FORCA member (in practice always
// called from a parent account; a trainee with no linked children just gets
// an empty list back, same "no admin-impersonation escape hatch" shape as
// listMyFamily.ts).
//
// Subscriptions are parent-only purchasable — see the FORCA billing spec.
// This lists, per linked child, every ForcaSubscriptionProductItem she's
// eligible to see: PUBLIC products, or PRIVATE ones that explicitly target
// this caller (targetParentUids) — the same visibility rule
// adminSaveForcaSubscriptionProduct.ts writes.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const [linksRes, productsRes, groupsRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':prefix': 'FAMILY#' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND active = :true',
      ExpressionAttributeValues: { ':prefix': 'FORCASUBPRODUCT#', ':metadata': 'METADATA', ':true': true },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
    })),
  ]);

  const links = (linksRes.Items ?? []) as FamilyLinkItem[];
  const groupNameById = new Map<string, string>(
    ((groupsRes.Items ?? []) as (GroupItem & { PK: string })[]).map((g) => [g.PK.replace('GROUP#', ''), g.name]),
  );

  const eligibleProducts = ((productsRes.Items ?? []) as (ForcaSubscriptionProductItem & { PK: string })[])
    .filter((p) => p.visibility === 'PUBLIC' || (p.targetParentUids ?? []).includes(callerUid))
    .map((p) => ({
      id: p.PK.replace('FORCASUBPRODUCT#', ''),
      name: p.name,
      description: p.description ?? null,
      price: p.price,
      groupId: p.groupId,
      groupName: groupNameById.get(p.groupId) ?? null,
    }));

  const children = await Promise.all(links.map(async (link) => {
    const childRes = await ddb.send(new GetCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MEMBER#${link.childUid}`, SK: 'PROFILE' },
    }));
    const profile = childRes.Item as MemberProfileItem | undefined;
    if (!profile) return null;
    return {
      childUid: link.childUid,
      childName: deriveMemberName(profile),
      products: eligibleProducts,
    };
  }));

  return json(200, { children: children.filter((c): c is NonNullable<typeof c> => c !== null) });
}
