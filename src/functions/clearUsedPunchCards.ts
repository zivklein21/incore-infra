// EventBridge Scheduled Rule — unix-cron "5 0 1 * *" (00:05 on the 1st of
// the month), Asia/Jerusalem. Removes fully-consumed punch cards.
//
// The original scanned wallets/primary.adminPunchCards arrays and filtered
// out depleted entries. This port's entity design already keeps punch cards
// as standalone PunchCardItem rows (see bookClass.ts's key-design notes), so
// "clearing" one is just deleting the item outright rather than rewriting an
// array.
import { ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';

export async function handler(): Promise<void> {
  const depleted: Array<{ PK: string; SK: string }> = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND remainingPunches <= :zero',
      ExpressionAttributeValues: { ':prefix': 'PUNCHCARD#', ':zero': 0 },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items ?? []) depleted.push({ PK: item.PK, SK: item.SK });
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  await Promise.all(depleted.map((key) => ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }))));

  console.log(`[clearUsedPunchCards] Cleared ${depleted.length} depleted punch cards`);
}
