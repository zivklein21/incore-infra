import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { deriveMemberName, type MemberProfileItem, type FamilyLinkItem } from '../lib/entities';

// POST /adminLinkFamilyMember
// Auth: Cognito JWT, caller must be admin
// Body: { parentUid: string, childUid: string }
//
// v1 is a simple one-parent-per-child tree (no multi-parent/co-parent
// support, no self-service member-initiated linking) — see the Family
// Accounts plan. Relaxing "one parent per child" later only means dropping
// the GSI1 check below; the schema already supports it (GSI1 on the child
// side naturally returns every parent).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { parentUid?: unknown; childUid?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const parentUid = typeof body.parentUid === 'string' ? body.parentUid.trim() : '';
  const childUid = typeof body.childUid === 'string' ? body.childUid.trim() : '';
  if (!parentUid || !childUid) return json(400, { error: 'missing_required_fields' });
  if (parentUid === childUid) return json(400, { error: 'cannot_link_self' });

  const [parentRes, childRes, existingLinkRes, childAlreadyLinkedRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${parentUid}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${childUid}`, SK: 'PROFILE' } })),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${parentUid}`, SK: `FAMILY#${childUid}` } })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      // GSI1 is shared by every entity with a "generic member-scoped
      // lookup" (registrations, support inquiries, orders, billing
      // agreements, ...) — without the GSI1SK prefix filter this matched
      // ANY GSI1 item for the member, not just family links, so basically
      // any active member with class history/orders/tickets tripped a
      // false "child_already_linked".
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'FAMILYOF#' },
    })),
  ]);

  const parentProfile = parentRes.Item as MemberProfileItem | undefined;
  const childProfile = childRes.Item as MemberProfileItem | undefined;
  if (!parentProfile) return json(404, { error: 'parent_not_found' });
  if (!childProfile) return json(404, { error: 'child_not_found' });
  if (existingLinkRes.Item) return json(409, { error: 'already_linked' });
  if ((childAlreadyLinkedRes.Items?.length ?? 0) > 0) return json(400, { error: 'child_already_linked' });

  const linkId = randomUUID();
  const nowIso = new Date().toISOString();
  const item: FamilyLinkItem = {
    PK: `MEMBER#${parentUid}`,
    SK: `FAMILY#${childUid}`,
    GSI1PK: `MEMBER#${childUid}`,
    GSI1SK: `FAMILYOF#${parentUid}`,
    linkId,
    parentUid,
    childUid,
    childName: deriveMemberName(childProfile),
    status: 'active',
    createdAt: nowIso,
    createdBy: callerUid,
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return json(200, { success: true, linkId });
}
