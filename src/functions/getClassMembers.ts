import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, MemberProfileItem, RegistrationItem } from '../lib/entities';

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

function deriveSubtitle(p: MemberProfileItem | undefined): string {
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

  const memberIds = Array.from(new Set([
    ...registrations.map((r) => r.userId),
    ...waitlist.map((w) => w.member),
  ]));
  const profiles = await Promise.all(
    memberIds.map((id) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${id}`, SK: 'PROFILE' } }))),
  );
  const profileById = new Map(memberIds.map((id, i) => [id, profiles[i].Item as MemberProfileItem | undefined]));

  const registered = registrations.map((r) => {
    const p = profileById.get(r.userId);
    return { id: r.userId, name: deriveName(p), subtitle: deriveSubtitle(p), membershipStatus: deriveStatus(p) };
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
