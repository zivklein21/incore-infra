import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { getMemberFullName } from '../lib/hypOrders';
import type { MemberProfileItem, MerchOrderItem } from '../lib/entities';

// POST /markMerchOrderDelivered
// Auth: Cognito JWT, admin or a coach with attendance:'write', and the
// order's trainee must be in one of her assigned groups (admin: any).
// Body: { orderId: string }
// Response: { success: true, deliveredAt: string }
//
// The coach's "handed it over" tap from MerchDeliveryWidget.tsx — flips
// deliveryStatus to 'delivered' and drops the order out of the sparse
// pending-delivery GSI3 (see entities.ts's MerchOrderItem), so it
// disappears from every coach's next-session list at once. Conditional on
// still being pending so two coaches tapping at once can't double-record.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance !== 'write') return json(403, { error: 'forbidden' });

  let body: { orderId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId) return json(400, { error: 'missing_fields', required: ['orderId'] });

  const key = { PK: `MERCHORDER#${orderId}`, SK: 'METADATA' };
  const orderRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const order = orderRes.Item as MerchOrderItem | undefined;
  if (!order) return json(404, { error: 'order_not_found' });
  if (order.status !== 'completed' || order.deliveryStatus !== 'pending') return json(400, { error: 'not_pending_delivery' });

  const [traineeRes, callerRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${order.userId}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' } })),
  ]);
  const trainee = traineeRes.Item as MemberProfileItem | undefined;
  if (!trainee || !groupInAccess(access, trainee.identity?.groupId)) return json(403, { error: 'forbidden' });
  const caller = callerRes.Item as MemberProfileItem | undefined;

  const nowIso = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: key,
      UpdateExpression: 'SET deliveryStatus = :delivered, deliveredAt = :now, deliveredBy = :by, deliveredByName = :byName, updatedAt = :now REMOVE GSI3PK, GSI3SK',
      ConditionExpression: 'deliveryStatus = :pending',
      ExpressionAttributeValues: {
        ':delivered': 'delivered', ':pending': 'pending', ':now': nowIso, ':by': callerUid,
        ':byName': caller ? getMemberFullName(caller) : '',
      },
    }));
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return json(400, { error: 'not_pending_delivery' });
    throw err;
  }

  console.log(`[markMerchOrderDelivered] order=${orderId} trainee=${order.userId} by ${callerUid}`);
  return json(200, { success: true, deliveredAt: nowIso });
}
