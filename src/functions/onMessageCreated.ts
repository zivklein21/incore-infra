import type { DynamoDBStreamEvent } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { newImage } from '../lib/dynamoStream';
import type { MemberProfileItem } from '../lib/entities';
import { getExpoPushToken, sendExpoPush } from '../lib/push';

interface MessageItem {
  PK: string; SK: string;
  type?: string;
  classId?: string;
  title?: string;
  body?: string;
  suppressPush?: boolean;
}

// DynamoDB Stream trigger — fires on INSERT of a PK=MEMBER#<uid> SK=MESSAGE#<id> item.
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT') continue;
    const item = newImage<MessageItem>(record);
    if (!item || !item.PK.startsWith('MEMBER#') || !item.SK.startsWith('MESSAGE#')) continue;

    // Blast messages from triggerTemplateAlert/waitlist offers already send
    // push directly; skip here.
    if (item.suppressPush === true) continue;

    const memberId = item.PK.replace('MEMBER#', '');
    const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: item.PK, SK: 'PROFILE' } }));
    const profile = memberRes.Item as MemberProfileItem | undefined;
    if (!profile) continue;

    const token = getExpoPushToken(profile);
    if (!token) continue;

    const title = item.title || 'INCORE';
    const body = item.body ?? '';
    const messageId = item.SK.replace('MESSAGE#', '');

    await sendExpoPush(token, title, body, { messageId, type: item.type ?? '', classId: item.classId ?? '' });
    console.log(`[onMessageCreated] push sent to member=${memberId}`);
  }
}
