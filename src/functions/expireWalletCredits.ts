// EventBridge Scheduled Rule — unix-cron "20 0 1 * *" (00:20 on the 1st), Asia/Jerusalem.
//
// Terms of service: unused-session credit is valid until the end of the month
// after the one it was earned in. Removes every lapsed creditBuckets entry
// (earned before last month) from WALLET#PRIMARY and subtracts it from
// extraPunches — see lib/walletCredit.ts for how buckets are kept.
//
// Each wallet is updated with a condition on its current bucket values, so a
// booking that spends credit at the same moment just makes this one retry
// next month rather than double-subtracting.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { WalletItem } from '../lib/entities';
import { expiredBuckets } from '../lib/walletCredit';

export async function handler(): Promise<void> {
  const wallets: WalletItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'SK = :sk AND attribute_exists(creditBuckets)',
      ExpressionAttributeValues: { ':sk': 'WALLET#PRIMARY' },
      ExclusiveStartKey: lastKey,
    }));
    wallets.push(...(res.Items ?? []) as WalletItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  let expiredMembers = 0, expiredTotal = 0, errors = 0;

  for (const wallet of wallets) {
    const lapsed = expiredBuckets(wallet);
    const months = Object.keys(lapsed);
    if (months.length === 0) continue;

    const amount = Math.min(wallet.extraPunches ?? 0, months.reduce((sum, m) => sum + lapsed[m], 0));
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ':amount': -amount, ':now': new Date().toISOString() };
    months.forEach((m, i) => { names[`#m${i}`] = m; values[`:v${i}`] = lapsed[m]; });

    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: wallet.PK, SK: wallet.SK },
        UpdateExpression: `ADD extraPunches :amount SET updatedAt = :now REMOVE ${months.map((_, i) => `creditBuckets.#m${i}`).join(', ')}`,
        ConditionExpression: months.map((_, i) => `creditBuckets.#m${i} = :v${i}`).join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
      expiredMembers++;
      expiredTotal += amount;
      console.log(`[expireWalletCredits] ${wallet.PK.replace('MEMBER#', '')}: expired ${amount} credit (${months.map((m) => `${m}:${lapsed[m]}`).join(', ')})`);
    } catch (err: any) {
      errors++;
      console.error(`[expireWalletCredits] ${wallet.PK} failed:`, err);
    }
  }

  console.log(`[expireWalletCredits] done — members=${expiredMembers} credits=${expiredTotal} errors=${errors}`);
}
