import { randomUUID } from 'crypto';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { getExpoPushToken, sendExpoPushBatch, type ExpoPushMessage } from '../push';
import { fmtDate, fmtTime } from '../templateResolver';
import { getProfile, parentOf } from '../formTemplates/submissions';
import type { ClassItem, RegistrationItem } from '../entities';

// A session this close is on the trainee's Home ("this week"), so trainees
// already know about it even though FORCA sends no automatic session reminder.
export const SESSION_UPDATE_NOTIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a saved plan/equipment change is worth a push: the session hasn't
 * started, and trainees already know about it — a push about this session
 * went out (traineesNotifiedAt), or it's within the window above.
 */
export function shouldNotifySessionUpdate(session: Pick<ClassItem, 'date' | 'traineesNotifiedAt'>, now = Date.now()): boolean {
  const start = new Date(session.date).getTime();
  if (Number.isNaN(start) || start <= now) return false;
  return !!session.traineesNotifiedAt || start - now <= SESSION_UPDATE_NOTIFY_WINDOW_MS;
}

export function sessionWhenText(session: Pick<ClassItem, 'date'>): { date: string; time: string } {
  const start = new Date(session.date);
  return { date: fmtDate(start, 'he'), time: fmtTime(start) };
}

/** The one push a saved plan/equipment change sends. */
export async function notifySessionUpdated(classId: string, session: ClassItem): Promise<number> {
  const { date, time } = sessionWhenText(session);
  return notifySessionTrainees(classId, session, {
    title: session.className || 'עדכון לאימון',
    body: `עודכן מערך/ציוד לאימון ${date} ${time}`,
    pushType: 'session_updated',
    messagePrefix: 'sessionupdate',
  });
}

/**
 * Push + inbox message to every trainee of a session, plus each one's linked
 * parent (who usually holds the device for a minor), deduped. Stamps
 * traineesNotifiedAt when at least one device was reached. Returns how many.
 */
export async function notifySessionTrainees(
  classId: string,
  session: ClassItem,
  message: { title: string; body: string; pushType: string; messagePrefix: string },
): Promise<number> {
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

  const { title, body, pushType, messagePrefix } = message;
  const nowMs = Date.now();
  const messageId = `${messagePrefix}_${classId}_${randomUUID()}`;
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
        body,
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
    if (token) pushMessages.push({ to: token, title, body, sound: 'default', data: { type: pushType, sessionId: classId } });
  }));

  const dispatched = await sendExpoPushBatch(pushMessages, 'notifySessionTrainees');
  console.log(`[notifySessionTrainees] ${pushType} class=${classId} recipients=${recipientIds.size} pushed=${dispatched}`);
  if (dispatched > 0) {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `CLASS#${classId}`, SK: 'METADATA' },
      UpdateExpression: 'SET traineesNotifiedAt = :now',
      ExpressionAttributeValues: { ':now': new Date(nowMs).toISOString() },
    }));
  }
  return dispatched;
}
