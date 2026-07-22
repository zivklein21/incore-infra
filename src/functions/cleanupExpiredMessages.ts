// EventBridge Scheduled Rule — unix-cron "0 * * * *" (hourly).
//
// NOTE: every MESSAGE# item this port writes already carries an
// expiresAtEpoch attribute, and dynamodb.tf enables native DynamoDB TTL on
// that attribute — so expired messages are now deleted automatically by
// DynamoDB itself, without this Lambda. This is kept only as a defensive
// backstop (TTL deletion isn't instant — AWS documents up to 48h latency)
// and ported per the migration plan; it may be safe to retire once TTL
// behavior is confirmed in production.
import { ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';

export async function handler(): Promise<void> {
  const nowIso = new Date().toISOString();
  const expired: Array<{ PK: string; SK: string }> = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND attribute_exists(expiresAt) AND expiresAt < :now',
      ExpressionAttributeValues: { ':prefix': 'MESSAGE#', ':now': nowIso },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items ?? []) expired.push({ PK: item.PK, SK: item.SK });
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  await Promise.all(expired.map((key) => ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: key }))));

  console.log(`[cleanup] deleted ${expired.length} expired messages`);
}
