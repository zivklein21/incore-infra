import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableForBrand, TABLE_NAME, FORCA_TABLE_NAME } from './dynamo';
import type { MemberProfileItem } from './entities';

export interface ResolvedMember {
  table: string;
  profile: MemberProfileItem;
}

// The one piece of machinery every "I only have a uid" endpoint needs now
// that FORCA's data lives in a separate table: there's no brand-aware
// signal on the Cognito token to say which table a given uid's profile is
// in (adding a custom attribute to the existing, already-in-use user pool
// would force Terraform to destroy and recreate it — not an option with
// real users on it), so this just checks both tables in parallel and
// returns whichever one has the item. Cheap and safe at this app's
// documented ≤50-user scale — two GetItems instead of one, not a scan.
export async function resolveMemberProfile(uid: string): Promise<ResolvedMember | null> {
  const key = { PK: `MEMBER#${uid}`, SK: 'PROFILE' };
  const [incoreRes, forcaRes] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key })),
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key })),
  ]);

  if (incoreRes.Item) return { table: TABLE_NAME, profile: incoreRes.Item as MemberProfileItem };
  if (forcaRes.Item) return { table: FORCA_TABLE_NAME, profile: forcaRes.Item as MemberProfileItem };
  return null;
}

// For admin endpoints that act on one member. The Backoffice sends the brand
// it's managing, which has to win: one login can have a profile in both tables,
// and resolveMemberProfile() would pick INCORE's. An older app build sends no
// brand, so that falls back to the lookup. Null means no such member.
export async function memberTableFor(memberId: string, brand: unknown): Promise<string | null> {
  if (brand === 'forca' || brand === 'incore') return tableForBrand(brand);
  return (await resolveMemberProfile(memberId))?.table ?? null;
}
