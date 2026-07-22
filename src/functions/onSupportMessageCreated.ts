import type { DynamoDBStreamEvent } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { newImage } from '../lib/dynamoStream';
import type { SupportInquiryItem, SupportInquiryMessageItem, MemberProfileItem } from '../lib/entities';
import { getExpoPushToken, sendExpoPush } from '../lib/push';

// DynamoDB Stream trigger — fires on INSERT of a PK=INQUIRY#<id> SK=MESSAGE#<id> item.
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT') continue;
    const msg = newImage<SupportInquiryMessageItem>(record);
    if (!msg || !msg.PK.startsWith('INQUIRY#') || !msg.SK.startsWith('MESSAGE#')) continue;

    // System messages and auto-replies don't trigger push.
    if (msg.sender === 'system' || msg.isAutoReply) continue;

    const inquiryRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: msg.PK, SK: 'METADATA' } }));
    const inquiry = inquiryRes.Item as SupportInquiryItem | undefined;
    if (!inquiry) continue;

    const userId = inquiry.userId ?? '';
    const userDisplayName = inquiry.userDisplayName ?? 'Member';
    const preview = msg.text.length > 80 ? `${msg.text.slice(0, 80)}…` : msg.text;

    if (msg.sender === 'member') {
      const adminsRes = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': 'ROLE#admin' },
      }));
      const admins = (adminsRes.Items ?? []) as MemberProfileItem[];
      await Promise.all(admins.map(async (admin) => {
        const token = getExpoPushToken(admin);
        if (!token) return;
        await sendExpoPush(token, `Support: ${userDisplayName}`, preview);
      }));
    } else if (msg.sender === 'admin' && userId) {
      const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${userId}`, SK: 'PROFILE' } }));
      const member = memberRes.Item as MemberProfileItem | undefined;
      if (!member) continue;
      const token = getExpoPushToken(member);
      if (!token) continue;
      await sendExpoPush(token, 'INCORE Support', preview);
    }
  }
}
