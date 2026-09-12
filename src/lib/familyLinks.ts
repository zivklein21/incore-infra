import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import { resolveMemberProfile } from './memberLookup';
import { deriveMemberName, type FamilyLinkItem } from './entities';

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
  const [resolvedParent, resolvedChild] = await Promise.all([
    resolveMemberProfile(parentUid),
    resolveMemberProfile(childUid),
  ]);
  if (!resolvedParent) return { ok: false, error: 'parent_not_found' };
  if (!resolvedChild) return { ok: false, error: 'child_not_found' };
  // INCORE and FORCA are fully separate tables — a family link is a single
  // item that has to live in one of them, so a parent and child in
  // different tables can't be linked at all, not just "shouldn't be." This
  // is the same rule the old single-table brand_mismatch check enforced,
  // now structural rather than a value comparison.
  if (resolvedParent.table !== resolvedChild.table) return { ok: false, error: 'brand_mismatch' };
  const table = resolvedParent.table;
  const { profile: childProfile } = resolvedChild;

  const [existingLinkRes, childAlreadyLinkedRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: table, Key: { PK: `MEMBER#${parentUid}`, SK: `FAMILY#${childUid}` } })),
    ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI1',
      // GSI1 is shared by every entity with a "generic member-scoped
      // lookup" (registrations, support inquiries, orders, billing
      // agreements, ...) — without the GSI1SK prefix filter this matched
      // ANY GSI1 item for the member, not just family links.
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':prefix': 'FAMILYOF#' },
    })),
  ]);
  if (existingLinkRes.Item) return { ok: false, error: 'already_linked' };
  if ((childAlreadyLinkedRes.Items?.length ?? 0) > 0) return { ok: false, error: 'child_already_linked' };

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

  await ddb.send(new PutCommand({ TableName: table, Item: item }));

  return { ok: true, linkId };
}

export type VerifyFamilyLinkResult =
  | { ok: true; table: string }
  | { ok: false };

// Authorization check for the parent-session (no ActiveProfileContext
// switch) FORCA Child Switcher endpoints — getChildProfile.ts,
// getChildAttendanceHistory.ts, getChildOrders.ts, getChildUploadUrl.ts,
// saveChildMedicalClearance.ts. A caller only gets to read/write childUid's
// data through these if the exact FAMILY# link item exists (same PK/SK
// createFamilyLink writes), i.e. she really is childUid's linked parent —
// not just anyone who knows a uid. Deliberately doesn't accept an
// isAdmin() bypass: admins have their own already-existing endpoints
// (getMemberDetail.ts etc.) for this.
export async function verifyFamilyLink(parentUid: string, childUid: string): Promise<VerifyFamilyLinkResult> {
  const resolvedParent = await resolveMemberProfile(parentUid);
  if (!resolvedParent) return { ok: false };
  const res = await ddb.send(new GetCommand({
    TableName: resolvedParent.table,
    Key: { PK: `MEMBER#${parentUid}`, SK: `FAMILY#${childUid}` },
  }));
  if (!res.Item) return { ok: false };
  return { ok: true, table: resolvedParent.table };
}
