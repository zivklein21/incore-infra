import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ClassItem, MemberProfileItem, MembershipItem, RegistrationItem } from './entities';
import { maybeSendSoleAttendeeAlert } from './soleAttendeeAlert';
import { getExpoPushToken, sendExpoPush } from './push';
import { expiryPushBody, paidByMembership, PUSH_TITLE } from './membershipExpiry';

// INCORE: when a member's membership really ends (not renewed — see
// needsBookingCleanup), the future bookings it was paying for are cancelled
// (MEMBERSHIP and FUTURE_SUBSCRIPTION); bookings paid with wallet credit or a
// punch card, and trials, stay. She books again after renewing, and always
// gets a push saying the membership ended. Called by expireMemberships.
//
// Each booking is cancelled like adminCancelRegistration does it, in one
// transaction: the REG item goes, a CANCEL# record (ADMIN_CANCELLED,
// cancellationReason 'membership_expired') is written, and the class frees a
// seat (onClassBookingChanged then offers it to the waitlist). The session
// isn't returned anywhere — the membership that paid for it is over.

export interface CancelledBooking { classId: string; classDate: string; consumedFrom: string; membershipId: string }

async function queryFutureMembershipBookings(memberId: string, nowIso: string): Promise<RegistrationItem[]> {
  const out: RegistrationItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as RegistrationItem[]).filter(paidByMembership));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  const withDates = await Promise.all(out.map(async (reg) => {
    if (reg.classDate) return reg;
    const cls = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${reg.classId}`, SK: 'METADATA' } }))).Item as ClassItem | undefined;
    return cls ? { ...reg, classDate: cls.date } : reg;
  }));
  return withDates.filter((r) => !!r.classDate && r.classDate > nowIso);
}

async function cancelOne(memberId: string, reg: RegistrationItem, nowIso: string): Promise<CancelledBooking | null> {
  const classKey = { PK: `CLASS#${reg.classId}`, SK: 'METADATA' };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: TABLE_NAME, Key: { PK: reg.PK, SK: reg.SK },
            ConditionExpression: '#status = :registered',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':registered': 'REGISTERED' },
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: `MEMBER#${memberId}`, SK: `CANCEL#${reg.classId}`,
              classId: reg.classId, status: 'ADMIN_CANCELLED',
              consumedFrom: reg.consumedFrom ?? '', creditBucket: reg.creditBucket ?? null,
              membershipId: reg.membershipId ?? '', adminCardId: reg.adminCardId ?? null,
              weekKey: reg.weekKey ?? null, targetMonth: reg.targetMonth ?? '',
              cancelledAt: nowIso, cancellationReason: 'membership_expired', cancelledBy: 'expireMemberships',
              refundTo: 'none',
            },
          },
        },
        { Update: { TableName: TABLE_NAME, Key: classKey, UpdateExpression: 'ADD currentAttendeesCount :negOne', ExpressionAttributeValues: { ':negOne': -1 } } },
      ],
    }));
  } catch (err) {
    if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return null; // she cancelled it herself meanwhile
    throw err;
  }

  try {
    const cls = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: classKey }))).Item as ClassItem | undefined;
    if (cls) await maybeSendSoleAttendeeAlert(reg.classId, cls, Math.max(0, cls.currentAttendeesCount ?? 0));
  } catch (err) {
    console.error('[membershipExpiryCleanup] sole-attendee alert failed (non-fatal):', err);
  }
  return { classId: reg.classId, classDate: reg.classDate, consumedFrom: reg.consumedFrom ?? '', membershipId: reg.membershipId ?? '' };
}

/** A push to one INCORE member, if she has a device token. Never throws. */
export async function pushMember(memberId: string, body: string, data?: Record<string, unknown>): Promise<boolean> {
  try {
    const profile = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }))).Item as MemberProfileItem | undefined;
    const token = profile ? getExpoPushToken(profile) : null;
    if (!token) {
      console.log(`[push] member=${memberId} has no push token — not sent: ${body}`);
      return false;
    }
    await sendExpoPush(token, PUSH_TITLE, body, data);
    console.log(`[push] member=${memberId} sent: ${body}`);
    return true;
  } catch (err) {
    console.error(`[push] member=${memberId} failed`, err);
    return false;
  }
}

/**
 * Cancels the future bookings the ended membership paid for, marks the
 * ended memberships as handled (expiryCleanupAt + the cancelled list), logs
 * every booking, and sends her the "membership ended" push.
 */
export async function cleanUpAfterExpiry(memberId: string, ended: MembershipItem[], now: Date, dryRun: boolean): Promise<{ cancelled: CancelledBooking[]; wouldCancel: string[] }> {
  const nowIso = now.toISOString();
  const regs = await queryFutureMembershipBookings(memberId, nowIso);
  if (dryRun) return { cancelled: [], wouldCancel: regs.map((r) => `${r.classId}@${r.classDate}(${r.consumedFrom})`) };

  const cancelled: CancelledBooking[] = [];
  for (const reg of regs) {
    try {
      const done = await cancelOne(memberId, reg, nowIso);
      if (done) cancelled.push(done);
    } catch (err) {
      console.error(`[membershipExpiryCleanup] cancel failed member=${memberId} class=${reg.classId}`, err);
    }
  }

  const latest = [...ended].sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))[0];
  await Promise.all(ended.map((m) => ddb.send(new UpdateCommand({
    TableName: TABLE_NAME, Key: { PK: m.PK, SK: m.SK },
    UpdateExpression: m === latest ? 'SET expiryCleanupAt = :now, expiryCancelledBookings = :list' : 'SET expiryCleanupAt = :now',
    ExpressionAttributeValues: m === latest ? { ':now': nowIso, ':list': cancelled } : { ':now': nowIso },
  }))));

  console.log(`[membershipExpiryCleanup] member=${memberId} cancelled=${cancelled.length} ${JSON.stringify(cancelled)}`);
  await pushMember(memberId, expiryPushBody(cancelled.length), { type: 'membership_expired' });
  return { cancelled, wouldCancel: [] };
}
