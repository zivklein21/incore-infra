import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { HypBillingAgreementItem, HypAgreementKind } from './entities';

// Every open (active or paused) billing agreement a member has, optionally
// scoped to one kind. Via GSI1 (GSI1PK=MEMBER#<uid>, GSI1SK=AGREEMENT#<kind>#<id>)
// — see entities.ts's HypBillingAgreementItem key-design notes.
export async function queryOpenAgreementsForMember(uid: string, kind?: HypAgreementKind): Promise<HypBillingAgreementItem[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: kind ? 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)' : 'GSI1PK = :pk',
    FilterExpression: '#status IN (:active, :paused)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pk': `MEMBER#${uid}`,
      ':active': 'active',
      ':paused': 'paused',
      ...(kind ? { ':prefix': `AGREEMENT#${kind}#` } : {}),
    },
  }));
  return (res.Items ?? []).filter((i) => (i.GSI1SK as string)?.startsWith('AGREEMENT#')) as HypBillingAgreementItem[];
}
