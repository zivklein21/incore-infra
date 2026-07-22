import { GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { ClassItem, RegistrationItem, MemberProfileItem } from './entities';
import type { ResolvedMessage } from './templateResolver';

// Collects unique member IDs from a class's registrations (status=REGISTERED)
// and its waitlist array.
export async function extractMemberIds(classId: string, classItem: ClassItem): Promise<string[]> {
  const regsRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :registered',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
  }));

  const ids = new Set<string>();
  for (const item of (regsRes.Items ?? []) as RegistrationItem[]) {
    if (item.userId) ids.add(item.userId);
  }
  for (const entry of classItem.waitlist ?? []) {
    if (entry?.member) ids.add(entry.member);
  }
  return Array.from(ids);
}

export async function writeNotification(
  memberId: string,
  classId: string,
  classType: string,
  classDate: Date,
  resolved: ResolvedMessage,
  type: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const expiresAtMs = Date.now() + 24 * 60 * 60 * 1000;
  // Deterministic ID — prevents duplicates if the function is retried or called twice.
  const msgId = `${type}_${classId}`;

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `MEMBER#${memberId}`,
      SK: `MESSAGE#${msgId}`,
      type,
      title: resolved.title,
      body: resolved.body,
      bgColor: resolved.bgColor,
      textColor: resolved.textColor,
      classId,
      className: classType,
      classDate: classDate.toISOString(),
      createdAt: nowIso,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtEpoch: Math.floor(expiresAtMs / 1000),
      requiresAction: false,
      read: false,
    },
  }));
}

export async function getMemberProfile(memberId: string): Promise<MemberProfileItem | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' } }));
  return res.Item as MemberProfileItem | undefined;
}
