import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { memberTableFor } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deriveMemberName, type MemberProfileItem, type FamilyLinkItem } from '../lib/entities';

interface FamilyMemberSummary {
  uid: string;
  name: string;
  phone: string;
}

async function resolveMember(table: string, uid: string): Promise<FamilyMemberSummary | null> {
  const res = await ddb.send(new GetCommand({ TableName: table, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return null;
  return { uid, name: deriveMemberName(profile), phone: profile.identity?.phone ?? profile.phone ?? '' };
}

// ANY /adminGetMemberFamilyInfo?memberId=<uid>&brand=incore|forca
// Auth: Cognito JWT, caller must be admin
//
// Powers the "Family" card on MemberDetailsScreen — resolves BOTH
// directions of a member's family link in one call: the parent they're
// linked to (if this member is a child) and the children linked to them
// (if this member is a parent), each with enough detail (name, phone) to
// render directly without a second round trip.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const memberId = event.queryStringParameters?.memberId;
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const table = await memberTableFor(memberId, event.queryStringParameters?.brand);
  if (!table) return json(200, { parent: null, children: [] });

  const [childLinksRes, parentLinkRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'FAMILY#' },
    })),
    ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'FAMILYOF#' },
    })),
  ]);

  const childLinks = (childLinksRes.Items ?? []) as FamilyLinkItem[];
  const parentLink = (parentLinkRes.Items ?? [])[0] as FamilyLinkItem | undefined;

  const [children, parent] = await Promise.all([
    Promise.all(childLinks.map((l) => resolveMember(table, l.childUid))),
    parentLink ? resolveMember(table, parentLink.parentUid) : Promise.resolve(null),
  ]);

  return json(200, {
    parent,
    children: children.filter((c): c is FamilyMemberSummary => c !== null),
  });
}
