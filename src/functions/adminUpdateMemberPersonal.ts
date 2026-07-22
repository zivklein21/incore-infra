import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

function computeAge(birthday: Date): number {
  const now = new Date();
  let age = now.getFullYear() - birthday.getFullYear();
  const beforeBirthdayThisYear = now.getMonth() < birthday.getMonth() || (now.getMonth() === birthday.getMonth() && now.getDate() < birthday.getDate());
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

// POST /adminUpdateMemberPersonal
// Body: { memberId, firstName, lastName, birthday?: string (ISO), phone, email, role }
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: {
    memberId?: unknown; firstName?: unknown; lastName?: unknown; birthday?: unknown;
    phone?: unknown; email?: unknown; role?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const role = typeof body.role === 'string' ? body.role.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const identity: Record<string, unknown> = {
    ...(profile.identity ?? {}),
    name: [firstName, lastName].filter(Boolean).join(' '),
    first_name: firstName,
    last_name: lastName,
    phone, email, role,
  };
  // Birthday is the only thing the admin edits — age is always derived from
  // it. If left blank (a legacy/bulk-imported member with only a raw age on
  // file), leave both untouched instead of wiping the legacy age.
  if (typeof body.birthday === 'string' && body.birthday) {
    const d = new Date(body.birthday);
    if (!Number.isNaN(d.getTime())) {
      identity.birthday = body.birthday;
      identity.age = computeAge(d);
    }
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    // identity is a DynamoDB reserved keyword — bare here it fails every call.
    UpdateExpression: 'SET #identity = :identity',
    ExpressionAttributeNames: { '#identity': 'identity' },
    ExpressionAttributeValues: { ':identity': identity },
  }));

  return json(200, { success: true });
}
