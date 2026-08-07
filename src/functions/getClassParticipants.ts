import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { s3, BUCKET_NAME } from '../lib/s3';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, MemberProfileItem, RegistrationItem } from '../lib/entities';

const FILE_URL_EXPIRY_SECONDS = 900;

function presign(key: string | undefined): Promise<string | null> {
  if (!key) return Promise.resolve(null);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: FILE_URL_EXPIRY_SECONDS });
}

// Splits a resolved display name into a public-safe firstName + lastInitial
// pair — never returns the full last name.
function splitName(name: string): { firstName: string; lastInitial: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastInitial: '' };
  if (parts.length === 1) return { firstName: parts[0], lastInitial: '' };
  return { firstName: parts[0], lastInitial: parts[parts.length - 1][0].toUpperCase() };
}

function deriveName(p: MemberProfileItem | undefined): string {
  if (!p) return 'Unknown Member';
  return p.identity?.name
    || p.identity?.full_name
    || [p.identity?.first_name, p.identity?.last_name].filter(Boolean).join(' ')
    || p.name
    || 'Unknown Member';
}

// GET or POST /getClassParticipants?classId=xxx
// Auth: Cognito JWT (any signed-in member) — client-facing counterpart to
// getClassMembers.ts (admin-only). Returns ONLY public-safe fields for the
// registered roster (no waitlist, no membershipStatus, no phone/email): a
// first name + last initial, a presigned photo URL, and the trial flag.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let bodyClassId = '';
  if (event.body) {
    try {
      const body = JSON.parse(event.body) as { classId?: unknown };
      bodyClassId = typeof body.classId === 'string' ? body.classId : '';
    } catch { /* fall through to query-param lookup */ }
  }
  const classId = event.queryStringParameters?.classId ?? bodyClassId;
  if (!classId) return json(400, { error: 'missing_class_id' });

  const [classRes, regsRes, ownRegRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: `REG#${uid}` } })),
  ]);

  const classItem = classRes.Item as ClassItem | undefined;
  if (!classItem) return json(404, { error: 'class_not_found' });

  // Same 404-not-403 guard as getClassDetail.ts — a private class the caller
  // can't see must be indistinguishable from a class that doesn't exist.
  if (classItem.isPrivate) {
    const isBooked = (ownRegRes.Item as RegistrationItem | undefined)?.status === 'REGISTERED';
    const allowed = (classItem.allowedMemberIds ?? []).includes(uid);
    if (!allowed && !isBooked && !(await isAdmin(uid))) {
      return json(404, { error: 'class_not_found' });
    }
  }

  const registrations = (regsRes.Items ?? []) as RegistrationItem[];

  const memberIds = Array.from(new Set(
    registrations.filter((r) => r.consumedFrom !== 'TRIAL').map((r) => r.userId),
  ));
  const profiles = await Promise.all(
    memberIds.map((id) => ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${id}`, SK: 'PROFILE' } }))),
  );
  const profileById = new Map(memberIds.map((id, i) => [id, profiles[i].Item as MemberProfileItem | undefined]));
  const photoUrlById = new Map(
    await Promise.all(memberIds.map(async (id): Promise<[string, string | null]> => [id, await presign(profileById.get(id)?.photoKey)])),
  );

  const participants = registrations.map((r) => {
    if (r.consumedFrom === 'TRIAL') {
      const { firstName } = splitName(r.fullName || 'Trial Trainee');
      return { id: r.userId, firstName, lastInitial: '', photoUrl: null, isTrial: true };
    }
    const { firstName, lastInitial } = splitName(deriveName(profileById.get(r.userId)));
    return { id: r.userId, firstName, lastInitial, photoUrl: photoUrlById.get(r.userId) ?? null, isTrial: false };
  });

  return json(200, {
    capacity: classItem.capacity ?? 5,
    registered: participants.length,
    participants,
  });
}
