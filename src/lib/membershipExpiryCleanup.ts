import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ClassItem, MemberProfileItem, MembershipItem, RegistrationItem, WaitlistEntry } from './entities';
import { refundCreditItem } from './creditSpend';
import { ensureCreditBuckets } from './walletCredit';
import { broadcastSpotOpen } from './waitlistCore';
import { maybeSendSoleAttendeeAlert } from './soleAttendeeAlert';
import { getExpoPushToken, sendExpoPush } from './push';
import { EXPIRY_PUSH_BODY, EXPIRY_PUSH_TITLE, refundFor, waitlistWithout, type RefundTo } from './membershipExpiry';

// INCORE: when a member's membership really ends (not renewed — see
// needsBookingCleanup), every future booking of hers is cancelled, whatever
// paid for it (FUTURE_SUBSCRIPTION too), and she leaves every future
// waitlist. She books again after renewing. Called by expireMemberships.
//
// Each booking is cancelled like adminCancelRegistration does it, in one
// transaction: the REG item goes, a CANCEL# record (ADMIN_CANCELLED,
// cancellationReason 'membership_expired') is written, the class frees a
// seat (onClassBookingChanged then offers it to the waitlist). Membership
// sessions aren't returned (the membership is over); wallet credit and
// punch-card punches go back where they came from, as in cancelBooking.

export interface CancelledBooking { classId: string; classDate: string; consumedFrom: string; refundTo: RefundTo }

async function queryFutureRegistrations(memberId: string, nowIso: string): Promise<RegistrationItem[]> {
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
    out.push(...((res.Items ?? []) as RegistrationItem[]));
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
  const regKey = { PK: reg.PK, SK: reg.SK };
  let adminCardExists = false;
  if (reg.consumedFrom === 'ADMIN_CARD' && reg.adminCardId) {
    const card = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: `PUNCHCARD#${reg.adminCardId}` } }));
    adminCardExists = !!card.Item;
  }
  const refundTo = refundFor(reg, adminCardExists);

  const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Delete: {
        TableName: TABLE_NAME, Key: regKey,
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
          refundTo,
        },
      },
    },
    { Update: { TableName: TABLE_NAME, Key: classKey, UpdateExpression: 'ADD currentAttendeesCount :negOne', ExpressionAttributeValues: { ':negOne': -1 } } },
  ];
  if (refundTo === 'wallet') {
    await ensureCreditBuckets(memberId);
    items.push(refundCreditItem(memberId, reg.creditBucket, nowIso));
  } else if (refundTo === 'punch_card') {
    items.push({
      Update: {
        TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: `PUNCHCARD#${reg.adminCardId}` },
        UpdateExpression: 'ADD remainingPunches :one', ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':one': 1 },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
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
  return { classId: reg.classId, classDate: reg.classDate, consumedFrom: reg.consumedFrom ?? '', refundTo };
}

/** Takes her off every future class waitlist; a live offer she held moves to the next in line. */
async function leaveFutureWaitlists(memberId: string, nowIso: string): Promise<string[]> {
  const classes: ClassItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND #date > :now AND attribute_exists(waitlist)',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA', ':now': nowIso },
      ExclusiveStartKey: lastKey,
    }));
    classes.push(...((res.Items ?? []) as ClassItem[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const left: string[] = [];
  for (const cls of classes) {
    const before = (cls.waitlist ?? []) as WaitlistEntry[];
    const { waitlist, removed, hadOffer } = waitlistWithout(before, memberId);
    if (!removed) continue;
    const classId = cls.PK.replace('CLASS#', '');
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME, Key: { PK: cls.PK, SK: cls.SK },
        UpdateExpression: 'SET waitlist = :next',
        ConditionExpression: 'waitlist = :before', // only if unchanged since read
        ExpressionAttributeValues: { ':next': waitlist, ':before': before },
      }));
      left.push(classId);
      if (hadOffer) await broadcastSpotOpen(classId);
    } catch (err) {
      console.error(`[membershipExpiryCleanup] waitlist update skipped member=${memberId} class=${classId}`, err);
    }
  }
  return left;
}

/**
 * Cancels the member's future bookings and waitlist places, marks the ended
 * memberships as handled (expiryCleanupAt + the list), logs every booking,
 * and sends her a push when anything was cancelled.
 */
export async function cleanUpAfterExpiry(memberId: string, ended: MembershipItem[], now: Date, dryRun: boolean): Promise<{ cancelled: CancelledBooking[]; waitlistsLeft: string[]; wouldCancel: string[] }> {
  const nowIso = now.toISOString();
  const regs = await queryFutureRegistrations(memberId, nowIso);
  if (dryRun) {
    return { cancelled: [], waitlistsLeft: [], wouldCancel: regs.map((r) => `${r.classId}@${r.classDate}(${r.consumedFrom})`) };
  }

  const cancelled: CancelledBooking[] = [];
  for (const reg of regs) {
    try {
      const done = await cancelOne(memberId, reg, nowIso);
      if (done) cancelled.push(done);
    } catch (err) {
      console.error(`[membershipExpiryCleanup] cancel failed member=${memberId} class=${reg.classId}`, err);
    }
  }
  const waitlistsLeft = await leaveFutureWaitlists(memberId, nowIso);

  const latest = [...ended].sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))[0];
  await Promise.all(ended.map((m) => ddb.send(new UpdateCommand({
    TableName: TABLE_NAME, Key: { PK: m.PK, SK: m.SK },
    UpdateExpression: m === latest
      ? 'SET expiryCleanupAt = :now, expiryCancelledBookings = :list, expiryLeftWaitlists = :wl'
      : 'SET expiryCleanupAt = :now',
    ExpressionAttributeValues: m === latest ? { ':now': nowIso, ':list': cancelled, ':wl': waitlistsLeft } : { ':now': nowIso },
  }))));

  console.log(`[membershipExpiryCleanup] member=${memberId} cancelled=${cancelled.length} ${JSON.stringify(cancelled)} waitlistsLeft=${JSON.stringify(waitlistsLeft)}`);

  if (cancelled.length > 0) {
    try {
      const profile = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }))).Item as MemberProfileItem | undefined;
      const token = profile ? getExpoPushToken(profile) : null;
      if (token) await sendExpoPush(token, EXPIRY_PUSH_TITLE, EXPIRY_PUSH_BODY, { type: 'membership_expired' });
      else console.log(`[membershipExpiryCleanup] member=${memberId} has no push token — not notified`);
    } catch (err) {
      console.error(`[membershipExpiryCleanup] push failed member=${memberId}`, err);
    }
  }
  return { cancelled, waitlistsLeft, wouldCancel: [] };
}
