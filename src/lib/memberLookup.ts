import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME, FORCA_TABLE_NAME } from './dynamo';
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
