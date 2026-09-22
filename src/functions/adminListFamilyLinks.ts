import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deriveMemberName, type MemberProfileItem, type FamilyLinkItem } from '../lib/entities';

// GET/ANY /adminListFamilyLinks?parentUid=<uid>&brand=incore|forca
// Auth: Cognito JWT, caller must be admin
//
// Names are resolved live from each member's current profile — the
// FamilyLinkItem's own childName is a denormalized display hint set at link
// time only, never source of truth (see entities.ts).
//
// brand (used only by the no-parentUid "list everything" path) picks which
// table to Scan — the table itself is the brand filter now, same as
// getAllMembers.ts, so this only ever returns one brand's links per call.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const parentUid = event.queryStringParameters?.parentUid;
  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;

  let links: FamilyLinkItem[];
  let table: string;
  if (parentUid) {
    const resolvedParent = await resolveMemberProfile(parentUid);
    if (!resolvedParent) return json(404, { error: 'parent_not_found' });
    table = resolvedParent.table;
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${parentUid}`, ':prefix': 'FAMILY#' },
    }));
    links = (res.Items ?? []) as FamilyLinkItem[];
  } else {
    table = tableForBrand(brand);
    // Table is documented for <=50 users per brand (dynamodb.tf) — same
    // accepted full-scan tradeoff as getAllMemberProfiles() (memberScan.ts).
    links = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new ScanCommand({
        TableName: table,
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
      ddb.send(new GetCommand({ TableName: table, Key: { PK: `MEMBER#${link.parentUid}`, SK: 'PROFILE' } })),
      ddb.send(new GetCommand({ TableName: table, Key: { PK: `MEMBER#${link.childUid}`, SK: 'PROFILE' } })),
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
      brand: childProfile?.identity?.brand ?? parentProfile?.identity?.brand ?? 'incore',
    };
  }));

  return json(200, { links: resolved });
}
