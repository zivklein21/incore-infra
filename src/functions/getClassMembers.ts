import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, MemberProfileItem, RegistrationItem } from '../lib/entities';
import { legacyPlanLabel, loadProductNames, planLabel, planNameOf, queryPlanItems, type MemberPlanItems } from '../lib/memberPlanLabel';


// GET or POST /getClassMembers?classId=xxx
// Auth: Cognito JWT, caller must be admin
//
// Replaces useClassMembers.ts's two Firestore listeners (class doc for
// capacity/waitlist, registrations subcollection for the roster) plus their
// per-member getDoc() name lookups, in one combined read. No AWS WebSocket
// transport exists yet, so the client polls this instead of listening.
function deriveName(p: MemberProfileItem | undefined): string {
  if (!p) return 'Unknown Member';
  return p.identity?.name
    || p.identity?.full_name
    || [p.identity?.first_name, p.identity?.last_name].filter(Boolean).join(' ')
    || p.name
    || 'Unknown Member';
}

// The member's current plan (lib/memberPlanLabel.ts); for a booking with
// no current plan behind it any more (a past class), the membership it was
// booked against; then the legacy badge. '' = really no plan.
function deriveSubtitle(
  p: MemberProfileItem | undefined, items: MemberPlanItems | undefined, productNames: Map<string, string>,
  now: Date, bookedMembershipId?: string,
): string {
  const current = planLabel(items?.memberships ?? [], items?.punchCards ?? [], productNames, now);
  if (current) return current;
  const booked = bookedMembershipId ? items?.memberships.find((m) => m.membershipId === bookedMembershipId) : undefined;
  if (booked) {
    const name = planNameOf(booked, booked.productId ? productNames.get(booked.productId) : undefined);
    if (name) return name;
  }
  return legacyPlanLabel(p?.membership, now);
}

function deriveStatus(p: MemberProfileItem | undefined): 'active' | 'expiring' | 'expired' {
  const status = p?.membership?.status;
  return status === 'expiring' || status === 'expired' ? status : 'active';
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let bodyClassId = '';
  if (event.body) {
    try {
      const body = JSON.parse(event.body) as { classId?: unknown };
      bodyClassId = typeof body.classId === 'string' ? body.classId : '';
    } catch { /* fall through */ }
  }
  const classId = event.queryStringParameters?.classId ?? bodyClassId;
  if (!classId) return json(400, { error: 'missing_class_id' });

  const [classRes, regsRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    })),
  ]);

  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  const waitlist = classItem.waitlist ?? [];

  // Trial (guest) registrations have no MemberProfileItem to resolve — their
  // display name is denormalized directly onto the RegistrationItem instead.
  const memberIds = Array.from(new Set([
    ...registrations.filter((r) => r.consumedFrom !== 'TRIAL').map((r) => r.userId),
    ...waitlist.map((w) => w.member),
  ]));
  // Profiles, plus every listed member's memberships/punch cards (one Query
  // per prefix per member — a roster is a handful of people), then one
  // product-name batch.
  const now = new Date();
  const [profiles, planItems] = await Promise.all([
    Promise.all(memberIds.map((id) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${id}`, SK: 'PROFILE' } })))),
    queryPlanItems(memberIds),
  ]);
  const profileById = new Map(memberIds.map((id, i) => [id, profiles[i].Item as MemberProfileItem | undefined]));
  const productNames = await loadProductNames(
    Array.from(planItems.values()).flatMap((i) => i.memberships.map((m) => m.productId ?? '')),
  );

  const registered = registrations.map((r) => {
    if (r.consumedFrom === 'TRIAL') {
      // No MemberProfileItem to resolve a brand from — trials are an
      // INCORE-only concept for now, default to 'incore' so every
      // downstream brand filter can use a single uniform predicate.
      return { id: r.userId, name: r.fullName || 'Trial Trainee', subtitle: '', membershipStatus: 'active' as const, isTrial: true, brand: 'incore' as const };
    }
    const p = profileById.get(r.userId);
    const bookedId = r.consumedFrom === 'MEMBERSHIP' || r.consumedFrom === 'FUTURE_SUBSCRIPTION' ? r.membershipId : undefined;
    return { id: r.userId, name: deriveName(p), subtitle: deriveSubtitle(p, planItems.get(r.userId), productNames, now, bookedId), membershipStatus: deriveStatus(p), isTrial: false, brand: p?.identity?.brand ?? 'incore' };
  });

  const waitlistOut = waitlist.map((w) => {
    const p = profileById.get(w.member);
    return {
      id: w.member,
      name: deriveName(p),
      subtitle: deriveSubtitle(p, planItems.get(w.member), productNames, now),
      membershipStatus: deriveStatus(p),
      since: w.since,
      status: w.status,
      pendingSince: w.pendingSince ?? null,
      brand: p?.identity?.brand ?? 'incore',
    };
  });

  return json(200, {
    capacity: classItem.capacity ?? 5,
    date: classItem.date,
    classType: classItem.className ?? '',
    registered,
    waitlist: waitlistOut,
  });
}
