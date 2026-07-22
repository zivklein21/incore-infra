// EventBridge Scheduled Rule — unix-cron "0 2 * * *" (02:00 daily), Asia/Jerusalem.
// Hard-deactivates every product whose expires_at is in the past.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { ProductItem } from '../lib/entities';

export async function handler(): Promise<void> {
  const nowIso = new Date().toISOString();
  const products: ProductItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'SK = :sk AND active = :true AND attribute_exists(expires_at) AND expires_at <= :now',
      ExpressionAttributeValues: { ':sk': 'METADATA', ':true': true, ':now': nowIso },
      ExclusiveStartKey: lastKey,
    }));
    products.push(...(res.Items ?? []) as ProductItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  // Scan with SK='METADATA' also matches Class/other METADATA-suffixed
  // entities, so narrow to PRODUCT# items specifically.
  const toExpire = products.filter((p) => p.PK.startsWith('PRODUCT#'));

  if (toExpire.length === 0) {
    console.log('[expireProducts] nothing to expire');
    return;
  }

  await Promise.all(toExpire.map((p) =>
    ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: p.PK, SK: p.SK },
      UpdateExpression: 'SET active = :false',
      ExpressionAttributeValues: { ':false': false },
    })),
  ));

  console.log(`[expireProducts] marked_inactive=${toExpire.length}`);
}
