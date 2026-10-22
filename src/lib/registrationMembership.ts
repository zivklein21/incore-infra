import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { isMembershipUsableForClass, type MembershipItem, type RegistrationItem } from './entities';

// Finds the membership record a registration's usage was actually counted
// against, for cancellation refunds. The registration only stores
// membershipId + its own (class) targetMonth — but a membership is filed
// under the month it was created in, so a CUSTOM_MIGRATION bridge filed
// under 2026-08 that covers a 2026-09 class lives at MEMBERSHIP#2026-08#<id>,
// not MEMBERSHIP#2026-09#<id> (same reason bookClass.ts writes usage to
// membership.targetMonth, not the class's month). Exact key first; otherwise
// the latest record with that membershipId filed at or before the class's
// month (a migration can have been copied into several months under one id).
//
// FUTURE_SUBSCRIPTION bookings never incremented any membership counter
// (bookClass.ts only does that for consumedFrom === 'MEMBERSHIP'), so they
// resolve to null — refunding them would push usage below what was consumed.
export async function findRegistrationMembership(
  uid: string,
  reg: RegistrationItem,
): Promise<{ key: { PK: string; SK: string }; item: MembershipItem } | null> {
  if (!reg.membershipId || reg.consumedFrom === 'FUTURE_SUBSCRIPTION') return null;

  const exactKey = { PK: `MEMBER#${uid}`, SK: `MEMBERSHIP#${reg.targetMonth}#${reg.membershipId}` };
  const exact = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: exactKey }));
  if (exact.Item) return { key: exactKey, item: exact.Item as MembershipItem };

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: 'membershipId = :mid',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'MEMBERSHIP#', ':mid': reg.membershipId },
  }));
  const match = ((res.Items ?? []) as MembershipItem[])
    .filter((m) => !reg.targetMonth || m.targetMonth <= reg.targetMonth)
    .sort((a, b) => b.targetMonth.localeCompare(a.targetMonth))[0];
  if (!match) return null;

  return { key: { PK: `MEMBER#${uid}`, SK: `MEMBERSHIP#${match.targetMonth}#${reg.membershipId}` }, item: match };
}

// The membership a class is charged to, out of all of a member's records:
// the one filed under `month` (the class's month, or the current month for a
// future booking) — or, failing that and only when `allowEarlier`, the latest
// earlier ACTIVE record whose own date window covers the class (a
// CUSTOM_MIGRATION bridge filed 2026-09 with endDate 2026-10-10). Shared by
// bookClass.ts and adminAddToClass.ts so both charge the same record.
export function membershipForClass(
  all: MembershipItem[],
  classDate: Date,
  month: string,
  allowEarlier: boolean,
): MembershipItem | null {
  return all.filter((m) => m.targetMonth === month).find((m) => isMembershipUsableForClass(m, classDate))
    ?? (allowEarlier ? all
      .filter((m) => m.status === 'ACTIVE' && m.targetMonth < month
        && !!m.endDate && classDate <= new Date(m.endDate)
        && (!m.startDate || classDate >= new Date(m.startDate)))
      .sort((a, b) => b.targetMonth.localeCompare(a.targetMonth))[0] : undefined)
    ?? null;
}
