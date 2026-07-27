import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { MemberProfileItem } from '../lib/entities';

// GET /adminWhoAmI
// Auth: Cognito JWT (any signed-in member — deliberately NOT admin-gated,
// since answering "am I admin?" is this endpoint's entire job).
//
// The admin portal's AuthContext calls this once per session to decide
// authenticated vs unauthorized, the same role a Firestore
// members/{uid}.identity.role read used to play in the pre-migration admin
// tool. Kept separate from getProfile.ts (which does a heavier
// membership/photo-presign fetch for the member-facing app and isn't meant
// to be called just to check a role bit).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  const claims = event.requestContext.authorizer.jwt.claims;

  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
  }));
  const profile = res.Item as MemberProfileItem | undefined;
  const isAdmin = profile?.role === 'admin' || profile?.identity?.role === 'admin';

  return json(200, {
    uid,
    email: (claims.email as string | undefined) ?? profile?.email ?? profile?.identity?.email ?? null,
    name: profile?.identity?.name || profile?.name || null,
    isAdmin,
  });
}
