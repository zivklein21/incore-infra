import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import type { ClassItem, EquipmentItem, TrainingTypeItem } from '../lib/entities';

// POST /toggleSessionEquipment
// Body: { classId: string, equipmentId: string, taken: boolean }
// Auth: Cognito JWT, caller must have attendance:'write' (see
// getCoachAccess.ts) and the session's group must be one of hers — this is
// part of the same "running a session" workflow as marking attendance.
//
// The coach's "pack list" check at the start of a training session — taken:
// true adds { equipmentId, quantity } to the session's equipmentTaken list
// and bumps that EquipmentItem's outCount by quantity (computed server-side:
// a 'custom' requirement's fixed customQuantity, or a 'per_member' one
// resolved against this exact session's registered member count — see
// getCoachSessions.ts's neededQuantity); taken: false (an un-check, before
// the item's been logged returned) reverses both by the quantity stored at
// check-out time. See returnSessionEquipment.ts for logging everything back
// at once, and getCoachSessions.ts for how this surfaces as a checklist.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance !== 'write') return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; equipmentId?: unknown; taken?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const equipmentId = typeof body.equipmentId === 'string' ? body.equipmentId.trim() : '';
  const taken = body.taken === true;
  if (!classId || !equipmentId) return json(400, { error: 'missing_fields' });

  const classKey = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: classKey }));
  const session = classRes.Item as ClassItem | undefined;
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });
  if (session.closedAt && !access.isAdmin) return json(403, { error: 'session_closed' });

  const current = session.equipmentTaken ?? [];
  const existingEntry = current.find((t) => t.equipmentId === equipmentId);
  if (taken === !!existingEntry) return json(200, { success: true, equipmentTaken: current.map((t) => t.equipmentId) }); // no-op

  const equipmentKey = { PK: `EQUIPMENT#${equipmentId}`, SK: 'METADATA' };
  const equipmentRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: equipmentKey }));
  const equipment = equipmentRes.Item as EquipmentItem | undefined;
  if (!equipment) return json(404, { error: 'equipment_not_found' });

  let next: { equipmentId: string; quantity: number }[];
  let delta: number;

  if (taken) {
    // Resolve this requirement's needed quantity for THIS session, exactly
    // like getCoachSessions.ts does — a Group session's registered member
    // count is a QueryCommand (regs live under PK=CLASS#<id>), not derivable
    // from the ClassItem alone.
    let neededQuantity = 0;
    const trainingTypeRes = session.trainingTypeId
      ? await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${session.trainingTypeId}`, SK: 'METADATA' } }))
      : null;
    const trainingType = trainingTypeRes?.Item as TrainingTypeItem | undefined;
    const requirement = trainingType?.equipmentRequirements?.find((r) => r.equipmentId === equipmentId);
    if (requirement?.mode === 'custom') {
      neededQuantity = requirement.customQuantity ?? 0;
    } else if (requirement?.mode === 'per_member') {
      const regsRes = await ddb.send(new QueryCommand({
        TableName: FORCA_TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': classKey.PK, ':prefix': 'REG#' },
      }));
      neededQuantity = regsRes.Items?.length ?? 0;
    }

    next = [...current, { equipmentId, quantity: neededQuantity }];
    delta = neededQuantity;
  } else {
    next = current.filter((t) => t.equipmentId !== equipmentId);
    delta = -(existingEntry?.quantity ?? 0);
  }

  const outCount = Math.max(0, Math.min(equipment.quantity, equipment.outCount + delta));

  await Promise.all([
    ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: classKey,
      UpdateExpression: 'SET equipmentTaken = :equipmentTaken',
      ExpressionAttributeValues: { ':equipmentTaken': next },
    })),
    ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: equipmentKey,
      UpdateExpression: 'SET outCount = :outCount',
      ExpressionAttributeValues: { ':outCount': outCount },
    })),
  ]);

  return json(200, { success: true, equipmentTaken: next.map((t) => t.equipmentId) });
}
