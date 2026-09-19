import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';

// POST /updateCoachOwnProfile
// Body: { firstName, lastName, phone }
// Auth: Cognito JWT, any signed-in coach editing her OWN profile (identified
// via getUid(event), not a memberId param — unlike adminUpdateCoachPersonal.ts,
// which is admin-editing-someone-else). Coach Role epic, item 7's "Personal
// Details... full permission to edit her profile information" — the
// generic self-service updateProfile.ts doesn't reach her since it's hard-
// coded to the INCORE table (see its own comment), and she's FORCA-only.
//
// Deliberately excludes email (also the Cognito login username — changing
// it here would desync login, same reasoning as adminUpdateCoachPersonal.ts)
// and groupIds/coachPermissions (admin-only, via adminUpdateCoachPersonal.ts
// — a coach can't reassign her own groups or elevate her own permissions).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const key = { PK: `MEMBER#${callerUid}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });
  if (profile.identity?.role !== 'coach') return json(403, { error: 'not_a_coach' });

  let body: { firstName?: unknown; lastName?: unknown; phone?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!firstName) return json(400, { error: 'missing_first_name' });

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

  return json(200, { success: true, name: identity.name, phone });
}
