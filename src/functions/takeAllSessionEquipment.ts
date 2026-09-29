import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import { fetchSessionLookups, resolveSessionDetail } from '../lib/sessionDetail';
import type { ClassItem, EquipmentItem } from '../lib/entities';

// POST /takeAllSessionEquipment
// Body: { classId: string }
// Auth: Cognito JWT, caller must have equipment:'write' (see coachAccess.ts)
// and the session's group must be one of hers.
//
// The coach's start-of-session "took everything" bulk check-out — the
// mirror of returnSessionEquipment.ts. Resolves this session's full
// required-equipment list the exact same way lib/sessionDetail.ts's
// resolveSessionDetail() does (so "take all" can never disagree with what
// the checklist itself shows), then adds each not-yet-taken item to
// equipmentTaken at its resolved neededQuantity and bumps that
// EquipmentItem's outCount — same per-item math as
// toggleSessionEquipment.ts's taken:true branch, just applied to every
// still-untaken item at once instead of one at a time.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.equipment !== 'write') return json(403, { error: 'forbidden' });

  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: classKey }));
  const session = classRes.Item as (ClassItem & { PK: string }) | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });
  if (session.closedAt && !access.isAdmin) return json(403, { error: 'session_closed' });

  const lookups = await fetchSessionLookups([session]);
  const detail = await resolveSessionDetail(session, lookups, access);

  const current = session.equipmentTaken ?? [];
  const currentIds = new Set(current.map((t) => t.equipmentId));
  const toTake = detail.requiredEquipment.filter((item) => !currentIds.has(item.id));
  if (toTake.length === 0) return json(200, { success: true, equipmentTaken: current.map((t) => t.equipmentId) });

  const next = [...current, ...toTake.map((item) => ({ equipmentId: item.id, quantity: item.neededQuantity }))];

  await Promise.all([
    ...toTake.map(async (item) => {
      const equipmentKey = { PK: `EQUIPMENT#${item.id}`, SK: 'METADATA' };
      const equipmentRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: equipmentKey }));
      const equipment = equipmentRes.Item as EquipmentItem | undefined;
      if (!equipment) return;
      const outCount = Math.max(0, Math.min(equipment.quantity, equipment.outCount + item.neededQuantity));
      await ddb.send(new UpdateCommand({
        TableName: FORCA_TABLE_NAME,
        Key: equipmentKey,
        UpdateExpression: 'SET outCount = :outCount',
        ExpressionAttributeValues: { ':outCount': outCount },
      }));
    }),
    ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: classKey,
      UpdateExpression: 'SET equipmentTaken = :equipmentTaken',
      ExpressionAttributeValues: { ':equipmentTaken': next },
    })),
  ]);

  return json(200, { success: true, equipmentTaken: next.map((t) => t.equipmentId) });
}
