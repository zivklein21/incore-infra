import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getAllMemberProfiles } from '../lib/memberScan';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { pickActive, buildMembershipResponse } from './getMemberMembership';

// FORCA has no MembershipItem collection at all (a GroupItem doubles as the
// membership-plan concept — see GroupItem's doc comment); the only
// per-trainee record is the simple { title, start, end } admin-granted
// window on her own PROFILE item (see adminGrantForcaMembership.ts). Maps
// that into the same shape buildMembershipResponse() returns for an INCORE
// MembershipItem, so the admin Members list can render both uniformly.
async function loadForcaMemberships(): Promise<Record<string, unknown>> {
  const profiles = await getAllMemberProfiles(FORCA_TABLE_NAME);
  const now = Date.now();
  const result: Record<string, unknown> = {};
  for (const p of profiles) {
    const membership = p.membership as { title?: string; start?: string; end?: string } | undefined;
    if (!membership?.start || !membership?.end) continue;
    const startMs = new Date(membership.start).getTime();
    const endMs = new Date(membership.end).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    const status = now < startMs ? 'PENDING' : now > endMs ? 'EXPIRED' : 'ACTIVE';
    const memberId = (p.PK as string).replace('MEMBER#', '');
    result[memberId] = {
      productName: membership.title ?? '',
      status,
      monthlyUsed: 0,
      monthlyLimit: 0,
      manualAdjustment: 0,
      isAutoRenew: false,
      startDate: membership.start,
      endDate: membership.end,
    };
  }
  return result;
}

// GET or POST /getAllMemberMemberships?brand=incore|forca
// Auth: Cognito JWT, caller must be admin
//
// Powers the admin Members list — one membership per row, resolved to the
// same shape getMemberMembership.ts returns for a single member. A full
// Scan (not per-member queries) mirrors getAllMembers.ts's already-accepted
// <=50-user scale tradeoff. Defaults to 'incore' for callers that don't
// pass it yet, same convention as getAllMembers.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const brand = event.queryStringParameters?.brand === 'forca' ? 'forca' as const : 'incore' as const;
  if (brand === 'forca') {
    return json(200, { memberships: await loadForcaMemberships() });
  }

  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#' },
  }));

  const byMember = new Map<string, any[]>();
  for (const item of res.Items ?? []) {
    const memberId = (item.PK as string).replace('MEMBER#', '');
    const list = byMember.get(memberId);
    if (list) list.push(item); else byMember.set(memberId, [item]);
  }

  const result: Record<string, unknown> = {};
  await Promise.all(Array.from(byMember.entries()).map(async ([memberId, items]) => {
    const target = pickActive(items);
    if (target) result[memberId] = await buildMembershipResponse(target);
  }));

  return json(200, { memberships: result });
}
