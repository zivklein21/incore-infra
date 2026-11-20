import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { israelWallTimeToDate, type ClassItem, type ForcaAccessCut, type MemberProfileItem, type RegistrationItem } from '../entities';
import { hasActiveForcaMembership, registerMemberOnFutureGroupSessions } from '../sessionInstance';

// Option ב ("ביטול מוקדם לפי דין"): when Or sets the legal date D, the
// trainee's access ends at D, so the refund for after D matches the service
// she stops getting.
//  - profile.membership.end (the FORCA access gate, see hasActiveForcaMembership)
//    becomes the end of D, Israel time; the end before is kept on the stop
//    (accessCut.previousEnd) so removing the stop puts it back;
//  - she's taken off every session already created that starts after D
//    (sessions created later skip her by themselves: the membership gate).
// Membership start, group and history are not touched.

/** The last instant of `day` in Israel ("YYYY-MM-DD"). */
export function israelEndOfDayIso(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(israelWallTimeToDate(y, m - 1, d + 1, 0, 0).getTime() - 1).toISOString();
}

/** The first instant after `day` in Israel. */
const afterDayIso = (day: string) => new Date(new Date(israelEndOfDayIso(day)).getTime() + 1).toISOString();

async function loadProfile(memberId: string): Promise<MemberProfileItem | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' }, ConsistentRead: true }));
  return res.Item as MemberProfileItem | undefined;
}

/** Her registrations on sessions starting after `day` (and not over yet). */
async function registrationsAfter(memberId: string, day: string, now: Date): Promise<RegistrationItem[]> {
  const from = afterDayIso(day);
  const nowIso = now.toISOString();
  const out: RegistrationItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as RegistrationItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out.filter((r) => !!r.classDate && r.classDate >= from && r.classDate >= nowIso);
}

/** For the summary: the end now, and how many sessions she'd come off. */
export async function previewAccessCut(memberId: string, legalDay: string, now: Date = new Date()): Promise<{ currentEnd: string | null; sessionsRemoved: number }> {
  const [profile, regs] = await Promise.all([loadProfile(memberId), registrationsAfter(memberId, legalDay, now)]);
  const end = profile?.membership?.end;
  return { currentEnd: typeof end === 'string' ? end : null, sessionsRemoved: regs.length };
}

async function removeRegistration(memberId: string, r: RegistrationItem): Promise<boolean> {
  const cls = (await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } }))).Item as ClassItem | undefined;
  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: r.PK, SK: r.SK } }));
  if (cls && (cls.allowedMemberIds ?? []).includes(memberId)) {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: cls.PK, SK: 'METADATA' },
      // Same bookkeeping as adminAssignGroup.ts. capacity is a reserved keyword.
      UpdateExpression: 'SET allowedMemberIds = :ids ADD #capacity :negOne, currentAttendeesCount :negOne',
      ExpressionAttributeNames: { '#capacity': 'capacity' },
      ExpressionAttributeValues: { ':ids': (cls.allowedMemberIds ?? []).filter((id) => id !== memberId), ':negOne': -1 },
    }));
  }
  return true;
}

/**
 * Ends her access at `legalDay`. `keepPreviousEnd`: the end from before an
 * earlier cut (editing D), so a later removal still restores the original.
 */
export async function cutAccessAt(
  memberId: string, legalDay: string, by: string, keepPreviousEnd?: string | null, now: Date = new Date(),
): Promise<{ cut: ForcaAccessCut; sessionsRemoved: number }> {
  const profile = await loadProfile(memberId);
  const currentEnd = typeof profile?.membership?.end === 'string' ? profile.membership.end as string : null;
  const previousEnd = keepPreviousEnd !== undefined ? keepPreviousEnd : currentEnd;
  const newEnd = israelEndOfDayIso(legalDay);
  if (profile?.membership) {
    await ddb.send(new UpdateCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
      UpdateExpression: 'SET membership.#end = :end, membership.endedEarly = :info',
      ExpressionAttributeNames: { '#end': 'end' },
      ExpressionAttributeValues: { ':end': newEnd, ':info': { legalDay, previousEnd, at: now.toISOString(), by } },
    }));
  }
  // She may be on sessions between the old D and the new one (D moved later): put her back first.
  if (keepPreviousEnd !== undefined) await reRegister(memberId, profile, newEnd, now);
  const regs = await registrationsAfter(memberId, legalDay, now);
  let removed = 0;
  for (const r of regs) {
    try {
      if (await removeRegistration(memberId, r)) removed++;
    } catch (err) {
      console.error(`[forcaAccessCut] member=${memberId} class=${r.classId} not removed:`, err);
    }
  }
  console.log(`[forcaAccessCut] member=${memberId} access ends ${legalDay} (was ${previousEnd}); ${removed} later sessions removed`);
  return { cut: { legalDay, previousEnd, at: now.toISOString(), by }, sessionsRemoved: removed };
}

async function reRegister(memberId: string, profile: MemberProfileItem | undefined, end: string | null, now: Date): Promise<number> {
  const groupId = profile?.identity?.groupId;
  const membership = { ...(profile?.membership ?? {}), end };
  if (!groupId || !hasActiveForcaMembership({ membership }, now.getTime())) return 0;
  return registerMemberOnFutureGroupSessions(memberId, groupId);
}

/**
 * The stop with the cut was removed: membership end back to what it was
 * (only if nobody changed it since), and she's put back on her group's sessions.
 */
export async function restoreAccess(memberId: string, cut: ForcaAccessCut, now: Date = new Date()): Promise<{ restored: boolean; sessionsAdded: number }> {
  const profile = await loadProfile(memberId);
  const cutEnd = israelEndOfDayIso(cut.legalDay);
  if (!profile?.membership || profile.membership.end !== cutEnd) return { restored: false, sessionsAdded: 0 };
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    ConditionExpression: 'membership.#end = :cut',
    UpdateExpression: cut.previousEnd ? 'SET membership.#end = :prev REMOVE membership.endedEarly' : 'REMOVE membership.#end, membership.endedEarly',
    ExpressionAttributeNames: { '#end': 'end' },
    ExpressionAttributeValues: { ':cut': cutEnd, ...(cut.previousEnd ? { ':prev': cut.previousEnd } : {}) },
  }));
  const sessionsAdded = await reRegister(memberId, profile, cut.previousEnd, now);
  console.log(`[forcaAccessCut] member=${memberId} access restored to ${cut.previousEnd}; ${sessionsAdded} sessions added back`);
  return { restored: true, sessionsAdded };
}
