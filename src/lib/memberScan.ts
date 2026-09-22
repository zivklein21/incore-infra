import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { MemberProfileItem } from './entities';

// Scans every MEMBER#*/PROFILE item. A Scan (not a GSI query) is deliberate:
// each table is documented for <=50 users (see dynamodb.tf), and every
// caller of this (broadcast, birthday rewards, membership/expiry reminders)
// is an admin-triggered or once-a-day cron path, so the scan cost is
// negligible at that scale. Revisit with a dedicated GSI if that changes.
//
// tableName defaults to the incore table — none of this function's cron/
// broadcast callers touch FORCA data yet (see the FORCA data separation
// plan's deferred scope), only getAllMembers.ts passes tableForBrand()
// explicitly.
export async function getAllMemberProfiles(tableName: string = TABLE_NAME): Promise<MemberProfileItem[]> {
  const profiles: MemberProfileItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'PROFILE' },
      ExclusiveStartKey: lastKey,
    }));
    profiles.push(...(res.Items ?? []) as MemberProfileItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return profiles;
}
