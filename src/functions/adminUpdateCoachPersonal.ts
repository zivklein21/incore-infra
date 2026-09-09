import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminUpdateCoachPersonal
// Body: { memberId, firstName, lastName, phone }
// Auth: Cognito JWT, caller must be admin
// FORCA-only, coach-only — email is intentionally not editable here since
// it's also the account's Cognito username; changing it would desync login.
// See adminUpdateMemberPersonal.ts for the generic (INCORE) equivalent.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; firstName?: unknown; lastName?: unknown; phone?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  if (!firstName) return json(400, { error: 'missing_first_name' });

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });
  if (profile.identity?.role !== 'coach') return json(403, { error: 'not_a_coach' });

  const identity: Record<string, unknown> = {
    ...(profile.identity ?? {}),
    name: [firstName, lastName].filter(Boolean).join(' '),
    first_name: firstName,
    last_name: lastName,
    phone,
  };

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: key,
    // identity is a DynamoDB reserved keyword — bare here it fails every call.
    UpdateExpression: 'SET #identity = :identity',
    ExpressionAttributeNames: { '#identity': 'identity' },
    ExpressionAttributeValues: { ':identity': identity },
  }));

  return json(200, { success: true });
}
