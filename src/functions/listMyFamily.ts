import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { s3, BUCKET_NAME } from '../lib/s3';
import { computeComplianceFlags, deriveMemberName, type MemberProfileItem, type FamilyLinkItem } from '../lib/entities';

const PHOTO_URL_EXPIRY_SECONDS = 900;

function deriveStatus(val: unknown): 'active' | 'expiring' | 'expired' {
  return val === 'expiring' || val === 'expired' ? val : 'active';
}

// ANY /listMyFamily
// Auth: Cognito JWT — any authenticated member. No memberId override: a
// member can only ever list their own linked children, no admin-impersonation
// escape hatch needed (admins already have adminListFamilyLinks).
//
// Powers the client app's profile switcher — see the Family Accounts plan.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const linksRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':prefix': 'FAMILY#' },
  }));
  const links = (linksRes.Items ?? []) as FamilyLinkItem[];

  const children = await Promise.all(links.map(async (link) => {
    const childRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${link.childUid}`, SK: 'PROFILE' } }));
    const profile = childRes.Item as MemberProfileItem | undefined;
    if (!profile) return null;

    let photoUrl: string | null = null;
    if (profile.photoKey) {
      try {
        photoUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: profile.photoKey }), { expiresIn: PHOTO_URL_EXPIRY_SECONDS });
      } catch { photoUrl = null; }
    }

    return {
      uid: link.childUid,
      name: deriveMemberName(profile),
      photoUrl,
      membershipStatus: deriveStatus(profile.membership?.status),
      brand: profile.identity?.brand ?? 'incore',
      ...computeComplianceFlags(profile),
    };
  }));

  return json(200, { children: children.filter((c): c is NonNullable<typeof c> => c !== null) });
}
