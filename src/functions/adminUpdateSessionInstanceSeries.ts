import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminUpdateSessionInstanceSeries
// Body: { recurringSessionId: string, coachId?: string | null, coachName?: string | null, location?: string | null, manualEquipment?: { equipmentId: string, quantity: number }[] | null }
// Auth: Cognito JWT, admin-only — same gating as adminUpdateSessionInstance.ts.
//
// The "this and all future occurrences" counterpart of
// adminUpdateSessionInstance.ts's single-instance edit — patches
// coach/location/equipment in place on every not-yet-occurred ClassItem
// generated from this recurring template, same Scan-by-recurringSessionId-
// and-date pattern adminSaveRecurringSession.ts's own template-edit path
// already uses (see that file's in-place-patch branch). Deliberately has NO
// `date`/`endDate` field, unlike the single-instance endpoint — each future
// instance already has its own distinct date; there's no single date value
// that would make sense to stamp across all of them. A past instance is
// never touched, same "future only" rule as deleteFutureInstances().
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { recurringSessionId?: unknown; coachId?: unknown; coachName?: unknown; location?: unknown; manualEquipment?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const recurringSessionId = typeof body.recurringSessionId === 'string' ? body.recurringSessionId.trim() : '';
  if (!recurringSessionId) return json(400, { error: 'missing_recurring_session_id' });

  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (body.coachId === null) {
    removes.push('coachId', 'coachName');
  } else if (typeof body.coachId === 'string' && body.coachId) {
    sets.push('coachId = :coachId', 'coachName = :coachName');
    values[':coachId'] = body.coachId;
    values[':coachName'] = typeof body.coachName === 'string' ? body.coachName : '';
  }
  if (body.location === null) {
    removes.push('#loc');
    names['#loc'] = 'location';
  } else if (typeof body.location === 'string' && body.location) {
    sets.push('#loc = :location');
    names['#loc'] = 'location';
    values[':location'] = body.location;
  }
  if (body.manualEquipment === null) {
    removes.push('manualEquipment');
  } else if (Array.isArray(body.manualEquipment)) {
    const seen = new Set<string>();
    const entries: { equipmentId: string; quantity: number }[] = [];
    for (const raw of body.manualEquipment) {
      if (typeof raw !== 'object' || raw === null) continue;
      const equipmentId = typeof (raw as Record<string, unknown>).equipmentId === 'string' ? (raw as Record<string, unknown>).equipmentId as string : '';
      if (!equipmentId.trim() || seen.has(equipmentId)) continue;
      const rawQuantity = (raw as Record<string, unknown>).quantity;
      const quantity = typeof rawQuantity === 'number' && Number.isFinite(rawQuantity) && rawQuantity >= 1 ? Math.floor(rawQuantity) : 1;
      seen.add(equipmentId);
      entries.push({ equipmentId, quantity });
    }
    if (entries.length > 0) { sets.push('manualEquipment = :manualEquipment'); values[':manualEquipment'] = entries; }
    else { removes.push('manualEquipment'); }
  }

  if (sets.length === 0 && removes.length === 0) return json(400, { error: 'no_fields_to_update' });

  const expressionParts: string[] = [];
  if (sets.length > 0) expressionParts.push(`SET ${sets.join(', ')}`);
  if (removes.length > 0) expressionParts.push(`REMOVE ${removes.join(', ')}`);
  const updateExpression = expressionParts.join(' ');

  const nowIso = new Date().toISOString();
  const futureRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'recurringSessionId = :rsid AND #dt >= :now',
    ExpressionAttributeNames: { '#dt': 'date' },
    ExpressionAttributeValues: { ':rsid': recurringSessionId, ':now': nowIso },
  }));
  const futureItems = (futureRes.Items ?? []) as { PK: string }[];

  await Promise.all(futureItems.map((item) => ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: item.PK, SK: 'METADATA' },
    UpdateExpression: updateExpression,
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }))));

  return json(200, { success: true, updatedCount: futureItems.length });
}
