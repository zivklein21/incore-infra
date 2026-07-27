import { randomUUID } from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './dynamo';
import type { SystemAlertItem } from './entities';

const ALERT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Call from any handler's catch block or failure branch worth surfacing on
// the admin dashboard's alert feed (e.g. a payment callback that couldn't
// be matched to an order). Never throws — a logging failure must not mask
// or replace the original error the caller is already handling.
export async function recordSystemAlert(params: {
  severity: SystemAlertItem['severity'];
  source: string;
  message: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const item: SystemAlertItem = {
    PK: `ALERT#${id}`,
    SK: 'METADATA',
    GSI1PK: 'ALERT',
    GSI1SK: `${createdAt}#${id}`,
    severity: params.severity,
    source: params.source,
    message: params.message,
    context: params.context,
    createdAt,
    expiresAtEpoch: Math.floor(Date.now() / 1000) + ALERT_TTL_SECONDS,
  };

  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  } catch {
    // Swallow — see comment above.
  }
}
