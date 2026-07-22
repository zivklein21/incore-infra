import type { DynamoDBStreamEvent } from 'aws-lambda';
import { oldImage } from '../lib/dynamoStream';
import type { MemberProfileItem } from '../lib/entities';
import { deleteCognitoUser } from '../lib/cognito';

// DynamoDB Stream trigger — fires on REMOVE of a PK=MEMBER#<uid> SK=PROFILE item.
export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  for (const record of event.Records) {
    if (record.eventName !== 'REMOVE') continue;
    const item = oldImage<MemberProfileItem>(record);
    if (!item || item.SK !== 'PROFILE' || !item.PK.startsWith('MEMBER#')) continue;

    const uid = item.PK.replace('MEMBER#', '');
    await deleteCognitoUser(uid);
  }
}
