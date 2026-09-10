// EventBridge Scheduled Rule — hourly (see locals.tf's scheduled_functions).
//
// FORCA-only: scans training sessions whose scheduled end time (session
// date + its training type's durationMinutes, or just its date if no
// duration is set) has already passed but which still have equipment
// checked out (ClassItem.equipmentTaken non-empty — see
// toggleSessionEquipment.ts / returnSessionEquipment.ts). One alert per
// session, ever — equipmentAlertSentAt stamps the session so re-runs don't
// re-alert on the same missing gear.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { recordSystemAlert } from '../lib/alerts';
import type { ClassItem, EquipmentItem, TrainingTypeItem } from '../lib/entities';

export async function handler(): Promise<void> {
  const sessionsRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND attribute_exists(equipmentTaken) AND size(equipmentTaken) > :zero AND attribute_not_exists(equipmentAlertSentAt)',
    ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA', ':zero': 0 },
  }));
  const sessions = (sessionsRes.Items ?? []) as (ClassItem & { PK: string })[];
  if (sessions.length === 0) return;

  const trainingTypesRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'TRAININGTYPE#', ':metadata': 'METADATA' },
  }));
  const trainingTypesById = new Map(
    ((trainingTypesRes.Items ?? []) as TrainingTypeItem[]).map((t) => [t.PK.replace('TRAININGTYPE#', ''), t]),
  );

  const equipmentRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'EQUIPMENT#', ':metadata': 'METADATA' },
  }));
  const equipmentNameById = new Map(
    ((equipmentRes.Items ?? []) as EquipmentItem[]).map((e) => [e.PK.replace('EQUIPMENT#', ''), e.name ?? '']),
  );

  const now = Date.now();

  for (const session of sessions) {
    const sessionStart = new Date(session.date).getTime();
    if (Number.isNaN(sessionStart)) continue;
    const trainingType = session.trainingTypeId ? trainingTypesById.get(session.trainingTypeId) : undefined;
    const durationMs = (trainingType?.durationMinutes ?? 0) * 60 * 1000;
    const sessionEnd = sessionStart + durationMs;
    if (now < sessionEnd) continue; // still in progress (or upcoming) — not late yet

    const classId = session.PK.replace('CLASS#', '');
    const taken = session.equipmentTaken ?? [];
    const equipmentSummaries = taken.map(({ equipmentId, quantity }) =>
      `${equipmentNameById.get(equipmentId) ?? equipmentId} (${quantity})`);

    await recordSystemAlert({
      severity: 'warning',
      source: 'checkUnreturnedEquipmentAlerts',
      message: `Equipment not returned after "${session.className ?? 'training session'}": ${equipmentSummaries.join(', ')}`,
      context: { classId, className: session.className, equipmentTaken: taken },
    });

    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: session.PK, SK: 'METADATA' },
      UpdateExpression: 'SET equipmentAlertSentAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));
  }
}
