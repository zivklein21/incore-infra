import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';

// POST /updatePhotoConsent
// Auth: Cognito JWT (any signed-in member, own profile only)
// Body: { allowed: boolean }
//
// Adult members only — under-18 members' photo consent comes from
// parental_consent.photoConsent (set once at signing, see
// submitParentalConsent.ts) and isn't editable here.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  let body: { allowed?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (typeof body.allowed !== 'boolean') return json(400, { error: 'missing_allowed' });

  const key = { PK: `MEMBER#${uid}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const forms = { ...(profile.forms ?? {}), photo_consent: body.allowed };

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET forms = :forms',
    ExpressionAttributeValues: { ':forms': forms },
  }));

  return json(200, { success: true });
}
