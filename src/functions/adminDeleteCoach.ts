import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminDeleteCoach
// Body: { memberId }
// Auth: Cognito JWT, caller must be admin
// FORCA-only, coach-only. A coach never registers to a class or holds a
// membership/wallet/punch card, so unlike adminDeleteMember.ts there's no
// registration/waitlist cleanup to do — just delete every item under
// PK=MEMBER#<id> in the FORCA table (the profile, plus anything else that
// may have accumulated under it).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const profileRes = await ddb.send(new GetCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
  }));
  const profile = profileRes.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });
  if (profile.identity?.role !== 'coach') return json(403, { error: 'not_a_coach' });

  const memberItemsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}` },
  }));
  const memberItems = (memberItemsRes.Items ?? []) as { PK: string; SK: string }[];

  await Promise.all(
    memberItems.map((item) => ddb.send(new DeleteCommand({
      TableName: FORCA_TABLE_NAME,
      Key: { PK: item.PK, SK: item.SK },
    }))),
  );

  return json(200, { success: true });
}
