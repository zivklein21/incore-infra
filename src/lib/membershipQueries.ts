import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { MembershipItem, RegistrationItem } from './entities';

// All REGISTERED/FUTURE_SUBSCRIPTION registrations a member holds for a given
// month, across every class — the DynamoDB replacement for Firestore's
// collectionGroup('registrations') query, via GSI1 (see bookClass.ts's
// key-design notes). Reused by handlePaymentSuccess, evictFutureRegistrations,
// and bookClass's own future-booking-limit check.
export async function queryFutureSubscriptionRegistrations(uid: string, targetMonth: string): Promise<RegistrationItem[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    FilterExpression: 'consumedFrom = :cf AND #status = :st',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pk': `MEMBER#${uid}`,
      ':prefix': `REG#${targetMonth}#`,
      ':cf': 'FUTURE_SUBSCRIPTION',
      ':st': 'REGISTERED',
    },
  }));
  return (res.Items ?? []) as RegistrationItem[];
}

// Every ACTIVE membership a member currently has, regardless of month — a
// member should only ever have one, but this exists specifically to find
// (and supersede/expire) any stragglers.
export async function queryAllActiveMemberships(uid: string): Promise<MembershipItem[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE' },
  }));
  return (res.Items ?? []) as MembershipItem[];
}

// A member's membership for one specific month, regardless of status —
// used by handlePaymentFailure to mark it past_due.
export async function queryMembershipForMonth(uid: string, targetMonth: string): Promise<MembershipItem | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    Limit: 1,
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': `MEMBERSHIP#${targetMonth}#` },
  }));
  return ((res.Items ?? [])[0] as MembershipItem | undefined) ?? null;
}

// Every membership item under one specific month, regardless of status —
// unlike queryMembershipForMonth (Limit: 1), this doesn't assume there's
// only one. A member can legitimately hold both a CUSTOM_MIGRATION bridge
// and a real paid membership for the same targetMonth at once (the bridge
// started the month, the real purchase lands mid-month), so callers that
// need to tell those apart — e.g. handlePaymentSuccess's idempotency check —
// must see every item, not whichever one happens to sort first.
export async function queryMembershipsForMonth(uid: string, targetMonth: string): Promise<MembershipItem[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': `MEMBERSHIP#${targetMonth}#` },
  }));
  return (res.Items ?? []) as MembershipItem[];
}
