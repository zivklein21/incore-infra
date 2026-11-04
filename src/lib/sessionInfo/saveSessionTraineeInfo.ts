import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { getCoachAccess, sessionInAccess } from '../coachAccess';
import { getExpoPushToken, sendExpoPushBatch, type ExpoPushMessage } from '../push';
import { fmtDate, fmtTime } from '../templateResolver';
import { getProfile, parentOf } from '../formTemplates/submissions';
import type { ClassItem, RegistrationItem } from '../entities';

export const TRAINEE_NOTE_MAX = 1000;
export const TRAINEE_EQUIPMENT_MAX_ITEMS = 30;
export const TRAINEE_EQUIPMENT_ITEM_MAX = 60;

// POST /saveSessionTraineeInfo
// Body: { classId: string, traineeNote?: string | null, traineeEquipment?: string[] | null }
// Auth: Cognito JWT — admin, or the session's own assigned coach (same
// sessionInAccess() ownership check as assignSessionWorkoutPlan.ts). Rides
// incoreWorkoutApi.ts's shared integration (300-integration cap).
//
// Sets/clears the trainee-facing note + "what to bring" list on ONE dated
// FORCA session instance (ClassItem.traineeNote/traineeEquipment). An
// omitted field is left untouched; null or empty clears it. Unlike the
// coach pack-list (manualEquipment/equipmentTaken, catalog-backed), the
// equipment list here is free text in the coach's own order.
//
// When the note's trimmed text actually changes to a non-empty value and
// the session hasn't started yet, every trainee registered to it (plus each
// one's linked parent, who usually holds the device for a minor) gets a
// push + inbox message with the session date/time and the note. Saving the
// same note again, clearing it, or editing only the equipment list sends
// nothing.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; traineeNote?: unknown; traineeEquipment?: unknown };
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
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });

  const sets: string[] = [];
  const removes: string[] = [];
  const values: Record<string, unknown> = {};
  const nowIso = new Date().toISOString();

  let noteChanged = false;
  let newNote = '';
  if (body.traineeNote !== undefined) {
    if (body.traineeNote !== null && typeof body.traineeNote !== 'string') return json(400, { error: 'invalid_note' });
    newNote = (body.traineeNote ?? '').trim();
    if (newNote.length > TRAINEE_NOTE_MAX) return json(400, { error: 'note_too_long' });
    if (newNote !== (session.traineeNote ?? '').trim()) {
      noteChanged = true;
      if (newNote) {
        sets.push('traineeNote = :note', 'traineeNoteUpdatedAt = :now', 'traineeNoteUpdatedBy = :by');
        values[':note'] = newNote;
        values[':now'] = nowIso;
        values[':by'] = callerUid;
      } else {
        removes.push('traineeNote', 'traineeNoteUpdatedAt', 'traineeNoteUpdatedBy');
      }
    }
  }

  if (body.traineeEquipment !== undefined) {
    if (body.traineeEquipment !== null && !Array.isArray(body.traineeEquipment)) return json(400, { error: 'invalid_equipment' });
    const items: string[] = [];
    for (const raw of (body.traineeEquipment ?? []) as unknown[]) {
      if (typeof raw !== 'string') continue;
      const item = raw.trim().slice(0, TRAINEE_EQUIPMENT_ITEM_MAX);
      if (item) items.push(item);
    }
    if (items.length > TRAINEE_EQUIPMENT_MAX_ITEMS) return json(400, { error: 'too_many_equipment_items' });
    if (items.length > 0) { sets.push('traineeEquipment = :equipment'); values[':equipment'] = items; }
    else if (session.traineeEquipment) removes.push('traineeEquipment');
  }

  if (sets.length > 0 || removes.length > 0) {
    const expressionParts: string[] = [];
    if (sets.length > 0) expressionParts.push(`SET ${sets.join(', ')}`);
    if (removes.length > 0) expressionParts.push(`REMOVE ${removes.join(', ')}`);
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: classKey,
      UpdateExpression: expressionParts.join(' '),
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    }));
  }

  const notified = noteChanged && newNote && new Date(session.date).getTime() > Date.now()
    ? await notifySessionTrainees(classId, session, newNote)
    : 0;

  return json(200, { success: true, notified });
}

async function notifySessionTrainees(classId: string, session: ClassItem, note: string): Promise<number> {
  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
  }));
  const traineeIds = new Set<string>(((regsRes.Items ?? []) as RegistrationItem[]).map((r) => r.userId));
  for (const id of session.allowedMemberIds ?? []) traineeIds.add(id);
  if (traineeIds.size === 0) return 0;

  // Trainee + linked parent, deduped (siblings share one parent).
  const recipientIds = new Set<string>(traineeIds);
  await Promise.all([...traineeIds].map(async (id) => {
    const parentId = await parentOf('forca', id);
    if (parentId) recipientIds.add(parentId);
  }));

  const start = new Date(session.date);
  const when = `${fmtDate(start, 'he')} · ${fmtTime(start)}`;
  const title = session.className ? `הערה לאימון ${session.className}` : 'הערה לאימון';
  const bodyText = `${when}\n${note}`;

  const nowMs = Date.now();
  const messageId = `sessionnote_${classId}_${randomUUID()}`;
  const expiresAtMs = nowMs + 7 * 24 * 60 * 60 * 1000;
  const pushMessages: ExpoPushMessage[] = [];

  await Promise.all([...recipientIds].map(async (uid) => {
    const profile = await getProfile('forca', uid);
    if (!profile) return;
    // suppressPush=true: pushed directly below, same convention as
    // sendCoachNotification.ts's MESSAGE# writes.
    await ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: {
        PK: `MEMBER#${uid}`,
        SK: `MESSAGE#${messageId}`,
        type: 'broadcast',
        title,
        body: bodyText,
        bgColor: '#7A004B',
        textColor: '#FFFFFF',
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtEpoch: Math.floor(expiresAtMs / 1000),
        requiresAction: false,
        read: false,
        suppressPush: true,
      },
    }));
    // sessionId, not classId: the app routes any push with data.classId to
    // the INCORE BookClass screen (usePushNotifications.ts), wrong for FORCA.
    const token = getExpoPushToken(profile);
    if (token) pushMessages.push({ to: token, title, body: bodyText, sound: 'default', data: { type: 'session_note', sessionId: classId } });
  }));

  const dispatched = await sendExpoPushBatch(pushMessages, 'saveSessionTraineeInfo');
  console.log(`[saveSessionTraineeInfo] class=${classId} recipients=${recipientIds.size} pushed=${dispatched}`);
  return dispatched;
}
