import { randomUUID } from 'crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { MemberProfileItem } from './entities';
import { getExpoPushToken, sendExpoPush } from './push';

// Writes an admin_notifications-equivalent record and fans out an Expo push
// to every member whose profile carries GSI1PK="ROLE#admin" (set at
// profile-write time — see MemberProfileItem in entities.ts). Mirrors the
// combined Firestore write + admin-role query + push fan-out that lived
// inline in individual Firebase functions (e.g. maybeSendDropoutAlert in
// functions/src/cancellation.ts).
export async function notifyAdmins(params: {
  type: string;
  priority: 'HIGH' | 'NORMAL';
  pushTitle: string;
  message: string;
  extra?: Record<string, unknown>;
}): Promise<void> {
  const { type, priority, pushTitle, message, extra = {} } = params;
  const nowIso = new Date().toISOString();
  const id = randomUUID();

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `NOTIFICATION#${id}`,
      SK: 'METADATA',
      GSI2PK: 'ADMINNOTIF',
      GSI2SK: `${nowIso}#${id}`,
      type,
      priority,
      message,
      isRead: false,
      createdAt: nowIso,
      ...extra,
    },
  }));

  const adminsRes = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'ROLE#admin' },
  }));
  const admins = (adminsRes.Items ?? []) as MemberProfileItem[];

  await Promise.all(admins.map(async (adminProfile) => {
    const token = getExpoPushToken(adminProfile);
    if (!token) return;
    await sendExpoPush(token, pushTitle, message);
  }));
}
