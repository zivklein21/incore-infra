import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deriveMemberName, type MemberProfileItem, type FamilyLinkItem } from '../lib/entities';

interface FamilyMemberSummary {
  uid: string;
  name: string;
  phone: string;
}

async function resolveMember(uid: string): Promise<FamilyMemberSummary | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' } }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return null;
  return { uid, name: deriveMemberName(profile), phone: profile.identity?.phone ?? profile.phone ?? '' };
}

// ANY /adminGetMemberFamilyInfo?memberId=<uid>
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

  const [childLinksRes, parentLinkRes] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'FAMILY#' },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'FAMILYOF#' },
    })),
  ]);

  const childLinks = (childLinksRes.Items ?? []) as FamilyLinkItem[];
  const parentLink = (parentLinkRes.Items ?? [])[0] as FamilyLinkItem | undefined;

  const [children, parent] = await Promise.all([
    Promise.all(childLinks.map((l) => resolveMember(l.childUid))),
    parentLink ? resolveMember(parentLink.parentUid) : Promise.resolve(null),
  ]);

  return json(200, {
    parent,
    children: children.filter((c): c is FamilyMemberSummary => c !== null),
  });
}
