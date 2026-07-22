import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { MemberProfileItem } from './entities';

// API Gateway's JWT authorizer already confirms the caller is a valid,
// authenticated member (see getUid in http.ts) — this only answers whether
// that member additionally has the admin role, same check the original
// Firebase functions did by reading their member profile document.
export async function isAdmin(uid: string): Promise<boolean> {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${uid}`, SK: 'PROFILE' },
  }));
  const item = res.Item as MemberProfileItem | undefined;
  return item?.role === 'admin' || item?.identity?.role === 'admin';
}
