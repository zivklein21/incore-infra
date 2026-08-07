import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, MemberProfileItem, MembershipItem, RegistrationItem } from '../lib/entities';

type FullMembershipItem = MembershipItem & { productName?: string; title?: string };

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

// CUSTOM_MIGRATION memberships (manually-created bridges for trainees
// onboarded mid-cycle from the old system, see adminGrantCustomMigration.ts)
// never populate the legacy profile.membership.plan bag, so a migrated
// member's registration otherwise falls through to a blank subtitle.
function deriveSubtitle(p: MemberProfileItem | undefined, membership?: FullMembershipItem): string {
  if (membership?.type === 'CUSTOM_MIGRATION') {
    return membership.productName || membership.title || 'מנוי מעבר';
  }
  const plan = p?.membership?.plan;
  return typeof plan === 'string' ? plan : '';
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
  const profiles = await Promise.all(
    memberIds.map((id) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${id}`, SK: 'PROFILE' } }))),
  );
  const profileById = new Map(memberIds.map((id, i) => [id, profiles[i].Item as MemberProfileItem | undefined]));

  // Resolve the actual MembershipItem each registration was booked against
  // (rather than the member's current active membership — the reg may be
  // for a past date) so CUSTOM_MIGRATION bridges resolve to a readable
  // subtitle instead of the empty legacy profile.membership bag.
  const membershipRegs = registrations.filter(
    (r) => (r.consumedFrom === 'MEMBERSHIP' || r.consumedFrom === 'FUTURE_SUBSCRIPTION') && r.membershipId,
  );
  const memberships = await Promise.all(
    membershipRegs.map((r) => ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `MEMBER#${r.userId}`, SK: `MEMBERSHIP#${r.targetMonth}#${r.membershipId}` },
    }))),
  );
  const membershipByRegKey = new Map(
    membershipRegs.map((r, i) => [`${r.userId}#${r.membershipId}`, memberships[i].Item as FullMembershipItem | undefined]),
  );

  const registered = registrations.map((r) => {
    if (r.consumedFrom === 'TRIAL') {
      return { id: r.userId, name: r.fullName || 'Trial Trainee', subtitle: '', membershipStatus: 'active' as const, isTrial: true };
    }
    const p = profileById.get(r.userId);
    const membership = membershipByRegKey.get(`${r.userId}#${r.membershipId}`);
    return { id: r.userId, name: deriveName(p), subtitle: deriveSubtitle(p, membership), membershipStatus: deriveStatus(p), isTrial: false };
  });

  const waitlistOut = waitlist.map((w) => {
    const p = profileById.get(w.member);
    return {
      id: w.member,
      name: deriveName(p),
      subtitle: deriveSubtitle(p),
      membershipStatus: deriveStatus(p),
      since: w.since,
      status: w.status,
      pendingSince: w.pendingSince ?? null,
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
