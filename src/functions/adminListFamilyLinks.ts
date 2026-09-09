import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deriveMemberName, type MemberProfileItem, type FamilyLinkItem } from '../lib/entities';

// GET/ANY /adminListFamilyLinks?parentUid=<uid>
// Auth: Cognito JWT, caller must be admin
//
// Names are resolved live from each member's current profile — the
// FamilyLinkItem's own childName is a denormalized display hint set at link
// time only, never source of truth (see entities.ts).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const parentUid = event.queryStringParameters?.parentUid;

  let links: FamilyLinkItem[];
  if (parentUid) {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${parentUid}`, ':prefix': 'FAMILY#' },
    }));
    links = (res.Items ?? []) as FamilyLinkItem[];
  } else {
    // Table is documented for <=50 users (dynamodb.tf) — same accepted
    // full-scan tradeoff as getAllMemberProfiles() (memberScan.ts).
    links = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'FAMILY#' },
        ExclusiveStartKey: lastKey,
      }));
      links.push(...(res.Items ?? []) as FamilyLinkItem[]);
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  }

  const resolved = await Promise.all(links.map(async (link) => {
    const [parentRes, childRes] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${link.parentUid}`, SK: 'PROFILE' } })),
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${link.childUid}`, SK: 'PROFILE' } })),
    ]);
    const parentProfile = parentRes.Item as MemberProfileItem | undefined;
    const childProfile = childRes.Item as MemberProfileItem | undefined;
    return {
      linkId: link.linkId,
      parentUid: link.parentUid,
      parentName: parentProfile ? deriveMemberName(parentProfile) : link.parentUid,
      childUid: link.childUid,
      childName: childProfile ? deriveMemberName(childProfile) : (link.childName ?? link.childUid),
      createdAt: link.createdAt,
      // INCORE and FORCA households are kept fully separate (see
      // lib/familyLinks.ts's brand_mismatch check) — both sides always
      // agree, so either profile's brand works here.
      brand: childProfile?.identity?.brand ?? parentProfile?.identity?.brand ?? 'incore',
    };
  }));

  return json(200, { links: resolved });
}
