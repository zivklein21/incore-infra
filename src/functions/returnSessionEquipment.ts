import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isCoachOrAdmin } from '../lib/auth';
import type { ClassItem, EquipmentItem } from '../lib/entities';

// POST /returnSessionEquipment
// Body: { classId: string }
// Auth: Cognito JWT, caller must be a coach or admin (isCoachOrAdmin)
//
// The coach's end-of-session "returned everything" log — decrements every
// EquipmentItem currently in this session's equipmentTaken by the exact
// quantity stored for it (set at check-out time — see
// toggleSessionEquipment.ts's neededQuantity resolution), clears
// equipmentTaken, and stamps equipmentReturnedAt.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isCoachOrAdmin(callerUid))) return json(403, { error: 'forbidden' });

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
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });

  const taken = session.equipmentTaken ?? [];
  const nowIso = new Date().toISOString();

  await Promise.all([
    ...taken.map(async ({ equipmentId, quantity }) => {
      const equipmentKey = { PK: `EQUIPMENT#${equipmentId}`, SK: 'METADATA' };
      const equipmentRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: equipmentKey }));
      const equipment = equipmentRes.Item as EquipmentItem | undefined;
      if (!equipment) return;
      const outCount = Math.max(0, equipment.outCount - quantity);
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
      UpdateExpression: 'SET equipmentTaken = :empty, equipmentReturnedAt = :now',
      ExpressionAttributeValues: { ':empty': [], ':now': nowIso },
    })),
  ]);

  return json(200, { success: true, equipmentReturnedAt: nowIso });
}
