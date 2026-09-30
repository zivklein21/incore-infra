import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { getMemberFullName } from '../lib/hypOrders';
import { MERCH_PENDING_DELIVERY_GSI3PK } from '../lib/merchPayments';
import type { MemberProfileItem, MerchOrderItem } from '../lib/entities';

// GET /getPendingMerchDeliveries
// Auth: Cognito JWT, admin or a coach with attendance !== 'none' (same gate
// as getTrainingHistory.ts — whoever runs the session hands the item over).
// Response: { deliveries: { orderId, memberId, memberName, createdAt, items: { productName, variantLabel, quantity }[] }[] }
//
// Every paid merch order not yet physically handed to its trainee, scoped
// to the caller's assigned groups (admin: all). Deliberately NOT matched to
// a specific session here — the client already holds the caller's own
// upcoming sessions + rosters (useCoachSessions()) and assigns each order to
// that trainee's next session itself (MerchDeliveryWidget.tsx), so this
// stays a single cheap sparse-index query instead of re-resolving sessions.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance === 'none') return json(403, { error: 'forbidden' });

  const orders: MerchOrderItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': MERCH_PENDING_DELIVERY_GSI3PK },
      ExclusiveStartKey: lastKey,
    }));
    orders.push(...((res.Items ?? []) as MerchOrderItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  if (orders.length === 0) return json(200, { deliveries: [] });

  // Group scoping + display names need each trainee's profile — batch-read
  // only the distinct trainees that actually have a pending order.
  const userIds = Array.from(new Set(orders.map((o) => o.userId)));
  const profilesById = new Map<string, MemberProfileItem>();
  for (let i = 0; i < userIds.length; i += 100) {
    const chunk = userIds.slice(i, i + 100);
    const res = await ddb.send(new BatchGetCommand({
      RequestItems: { [FORCA_TABLE_NAME]: { Keys: chunk.map((uid) => ({ PK: `MEMBER#${uid}`, SK: 'PROFILE' })) } },
    }));
    for (const p of (res.Responses?.[FORCA_TABLE_NAME] ?? []) as MemberProfileItem[]) {
      profilesById.set(p.PK.replace('MEMBER#', ''), p);
    }
  }

  const deliveries = orders
    .filter((o) => {
      const profile = profilesById.get(o.userId);
      return !!profile && groupInAccess(access, profile.identity?.groupId);
    })
    .map((o) => ({
      orderId: o.orderId,
      memberId: o.userId,
      memberName: getMemberFullName(profilesById.get(o.userId)!) || o.childName || '',
      createdAt: o.createdAt,
      items: o.items.map((li) => ({
        productName: li.merchProductName,
        variantLabel: li.merchVariantLabel,
        quantity: li.quantity,
      })),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return json(200, { deliveries });
}
