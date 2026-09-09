import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import { deriveMemberName, type MemberProfileItem, type FamilyLinkItem } from './entities';

export type CreateFamilyLinkResult =
  | { ok: true; linkId: string }
  | { ok: false; error: 'parent_not_found' | 'child_not_found' | 'already_linked' | 'child_already_linked' | 'brand_mismatch' };

// Shared by adminLinkFamilyMember.ts (explicit admin action) and
// adminCreateUser.ts (implicit link created alongside a new FORCA trainee).
// v1 is a simple one-parent-per-child tree (no multi-parent/co-parent
// support) — see adminLinkFamilyMember.ts's original note. Relaxing that
// later only means dropping the GSI1 check below; the schema already
// supports it (GSI1 on the child side naturally returns every parent).
export async function createFamilyLink(
  parentUid: string,
  childUid: string,
  callerUid: string,
): Promise<CreateFamilyLinkResult> {
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
      // ANY GSI1 item for the member, not just family links.
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'FAMILYOF#' },
    })),
  ]);

  const parentProfile = parentRes.Item as MemberProfileItem | undefined;
  const childProfile = childRes.Item as MemberProfileItem | undefined;
  if (!parentProfile) return { ok: false, error: 'parent_not_found' };
  if (!childProfile) return { ok: false, error: 'child_not_found' };
  if (existingLinkRes.Item) return { ok: false, error: 'already_linked' };
  if ((childAlreadyLinkedRes.Items?.length ?? 0) > 0) return { ok: false, error: 'child_already_linked' };
  // INCORE and FORCA are kept as fully separate households — a FORCA
  // trainee's parent must herself be a FORCA account and vice versa (see
  // adminCreateUser.ts, which only ever auto-links within the same brand).
  // Undefined brand on either side defaults to 'incore', same as everywhere
  // else identity.brand is read.
  const parentBrand = parentProfile.identity?.brand ?? 'incore';
  const childBrand = childProfile.identity?.brand ?? 'incore';
  if (parentBrand !== childBrand) return { ok: false, error: 'brand_mismatch' };

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

  return { ok: true, linkId };
}
