import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// GET or POST /getClasses?memberId=xxx
// Auth: Cognito JWT (any signed-in member). Defaults to the caller's own
// bookings; passing a different memberId (e.g. MemberDetailsScreen's admin
// Bookings tab, via useClientHome.ts) requires the caller to be admin — same
// pattern as getActiveMembership.ts / getWallet.ts.
//
// Returns every class with isBooked/isWaitlisted resolved for the caller —
// mirrors classesQuery.ts's fetchClientClasses, which combined three
// Firestore reads (class_types, classes, own registrations) into one
// client-side merge. className is already a resolved string on ClassItem
// (see entities.ts — DynamoDB has no reference type), so there's no
// separate class-type join needed here the way Firestore needed one.
//
// This is a full table Scan, not a Query. bookClass.ts's GSI2
// (GSI2PK=CLASSDATE#<date>) is deliberately per-day — built for the
// same-day-conflict check, not for "all classes" range queries — so
// there's no existing index that supports this access pattern without
// either N per-day queries or changing GSI2's partition scheme (which
// bookClass.ts already depends on and this endpoint intentionally leaves
// alone). A Scan is a direct, non-regressive port: the original Firestore
// code (classesQuery.ts) also read the entire classes collection
// unfiltered. Revisit if class volume ever makes a full scan expensive —
// e.g. a GSI2PK="CLASS" constant + GSI2SK=<date>#<classId> design, the
// same pattern HypOrderItem/HypBillingAgreementItem already use for their
// global chronological listings.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const uid = event.queryStringParameters?.memberId || callerUid;
  if (uid !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const [classesRes, regsRes] = await Promise.all([
    ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA' },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    })),
  ]);

  // consumedFrom is included alongside isBooked so callers (e.g.
  // useClientHome.ts's stats calc, which counts only MEMBERSHIP/
  // FUTURE_SUBSCRIPTION-sourced bookings) don't need a second N-read pass
  // just to get it — the registration items are already fetched above.
  const bookedClassInfo = new Map(
    ((regsRes.Items ?? []) as RegistrationItem[]).map((r) => [r.classId, r.consumedFrom]),
  );

  const classes = ((classesRes.Items ?? []) as ClassItem[]).map((c) => {
    const classId = c.PK.replace('CLASS#', '');
    const isWaitlisted = (c.waitlist ?? []).some(
      (entry) => entry.member === uid && (entry.status === 'waiting' || entry.status === 'pending'),
    );

    return {
      id: classId,
      classType: c.className ?? '',
      date: c.date,
      registered: c.currentAttendeesCount ?? 0,
      capacity: c.capacity ?? 5,
      isBooked: bookedClassInfo.has(classId),
      isWaitlisted,
      consumedFrom: bookedClassInfo.get(classId) ?? null,
    };
  });

  return json(200, { classes });
}
