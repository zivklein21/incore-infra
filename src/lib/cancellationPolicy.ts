import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ClassItem, MembershipItem, RegistrationItem } from './entities';

export const CANCEL_WINDOW_HOURS = 24;
export const MIN_TRAINEES_REQUIRED = 2;

export interface PolicyResult {
  isLegal: boolean;
  hoursUntilClass: number;
  remainingAfterCancel: number;
  isTimeOk: boolean;
  isOccupancyOk: boolean;
  isQuotaOk: boolean;
  allowedLegalCancellationsPerMonth: number;
  lateReason: string | null;
}

// Shared by cancelBooking (which acts on the result) and cancelPolicyPreview
// (which only returns it) — see functions/src/cancellation.ts for the
// original combined logic.
export async function evaluateCancellationPolicy(
  uid: string,
  regData: RegistrationItem,
  classItem: ClassItem,
): Promise<PolicyResult> {
  const classDate = new Date(classItem.date);
  const now = new Date();
  const currentAttendees = classItem.currentAttendeesCount ?? 0;

  const hoursUntilClass = (classDate.getTime() - now.getTime()) / 3_600_000;
  const remainingAfterCancel = Math.max(0, currentAttendees - 1);
  const isTimeOk = hoursUntilClass >= CANCEL_WINDOW_HOURS;
  // The floor only protects OTHER attendees from being left in a
  // too-small class — if the class is already below minimum with this
  // member still in it (e.g. they're the sole attendee), there's no one
  // else to protect and leaving can't make that any worse.
  const isOccupancyOk = currentAttendees < MIN_TRAINEES_REQUIRED || remainingAfterCancel >= MIN_TRAINEES_REQUIRED;

  const isWalletSource = regData.consumedFrom === 'EXTRA_PUNCH' || regData.consumedFrom === 'ADMIN_CARD';
  let isQuotaOk = isWalletSource;
  let allowedLegal = 2;

  if (!isWalletSource && regData.membershipId) {
    const membershipRes = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${uid}`, SK: `MEMBERSHIP#${regData.targetMonth}#${regData.membershipId}` },
    }));
    const membership = membershipRes.Item as MembershipItem | undefined;
    if (membership) {
      allowedLegal = membership.allowedLegalCancellationsPerMonth ?? 2;
      isQuotaOk = (membership.usage?.legalCancellationsUsed ?? 0) < allowedLegal;
    }
  }

  const isLegal = isTimeOk && isOccupancyOk && isQuotaOk;
  let lateReason: string | null = null;
  if (!isLegal) {
    if (!isTimeOk) lateReason = 'late_cancellation';
    else if (!isOccupancyOk) lateReason = 'minimum_occupancy';
    else lateReason = 'quota_exceeded';
  }

  return {
    isLegal,
    hoursUntilClass,
    remainingAfterCancel,
    isTimeOk,
    isOccupancyOk,
    isQuotaOk,
    allowedLegalCancellationsPerMonth: allowedLegal,
    lateReason,
  };
}
