// EventBridge Scheduled Rule — unix-cron "59 23 28-31 * *" (23:59 on days
// 28-31), Asia/Jerusalem; exits immediately unless today is the actual last
// day of the month.
import { ScanCommand, GetCommand, UpdateCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem, SupportInquiryItem } from '../lib/entities';
import { monthKey } from '../lib/entities';

export async function handler(): Promise<void> {
  const now = new Date();

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (tomorrow.getMonth() === now.getMonth()) {
    console.log('[monthEndRollover] Not the last day of the month — exiting');
    return;
  }

  const currentMonth = monthKey(now);
  console.log(`[monthEndRollover] month=${currentMonth} — starting`);

  const memberships: MembershipItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND #status = :active AND targetMonth = :month',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE', ':month': currentMonth },
      ExclusiveStartKey: lastKey,
    }));
    memberships.push(...(res.Items ?? []) as MembershipItem[]);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  let rolledOver = 0, locked = 0, skipped = 0, errors = 0;

  for (const mem of memberships) {
    const memberId = mem.PK.replace('MEMBER#', '');
    const isCustomMigration = mem.type === 'CUSTOM_MIGRATION';
    const nowIso = new Date().toISOString();

    try {
      const freshRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: mem.PK, SK: mem.SK } }));
      const fresh = freshRes.Item as MembershipItem | undefined;
      if (!fresh || fresh.status !== 'ACTIVE') { skipped++; continue; }
      if (fresh.monthEndProcessed?.[currentMonth]) { skipped++; continue; }

      const monthlyLimit = fresh.monthlyLimit ?? 0;
      const totalUsed = fresh.usage?.totalMonthlyUsed ?? 0;
      const remaining = Math.max(0, monthlyLimit - totalUsed);
      const newMonthEndProcessed = { ...fresh.monthEndProcessed, [currentMonth]: true };

      // usage is a DynamoDB reserved keyword — bare here it fails every call.
      const memUpdateExpr = isCustomMigration
        ? 'SET monthEndProcessed = :mep, #status = :expired, updatedAt = :now, #usage.totalMonthlyUsed = :cap'
        : 'SET monthEndProcessed = :mep, updatedAt = :now, #usage.totalMonthlyUsed = :cap';

      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: mem.PK, SK: mem.SK },
          UpdateExpression: memUpdateExpr,
          ExpressionAttributeNames: { '#status': 'status', '#usage': 'usage' },
          ExpressionAttributeValues: { ':mep': newMonthEndProcessed, ':now': nowIso, ':cap': monthlyLimit, ...(isCustomMigration ? { ':expired': 'expired' } : {}) },
        },
      }];

      if (remaining > 0) {
        transactItems.push({
          Update: {
            TableName: TABLE_NAME,
            Key: { PK: `MEMBER#${memberId}`, SK: 'WALLET#PRIMARY' },
            UpdateExpression: 'ADD extraPunches :remaining SET updatedAt = :now',
            ExpressionAttributeValues: { ':remaining': remaining, ':now': nowIso },
          },
        });
        rolledOver++;
        console.log(`[monthEndRollover] ${memberId}: rolling over ${remaining} unused slots (used ${totalUsed}/${monthlyLimit})`);
      } else {
        locked++;
      }

      await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

      if (isCustomMigration) {
        try {
          await ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
            UpdateExpression: 'SET subscriptionStatus = :s, updatedAt = :now',
            ExpressionAttributeValues: { ':s': 'NO_ACTIVE_SUBSCRIPTION', ':now': nowIso },
          }));
          console.log(`[monthEndRollover] ${memberId}: CUSTOM_MIGRATION expired → subscriptionStatus=NO_ACTIVE_SUBSCRIPTION`);
        } catch (memberErr: any) {
          console.error(`[monthEndRollover] Failed to update subscriptionStatus for member=${memberId}:`, memberErr);
        }
      }
    } catch (err: any) {
      errors++;
      console.error(`[monthEndRollover] Error for member=${memberId}:`, err);
    }
  }

  console.log(`[monthEndRollover] month=${currentMonth} done — rolledOver=${rolledOver} locked=${locked} skipped=${skipped} errors=${errors}`);

  // Auto-close all open support inquiries at month end.
  try {
    const openInquiries: SupportInquiryItem[] = [];
    let inqLastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :prefix) AND #status = :open',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':prefix': 'INQUIRY#', ':open': 'OPEN' },
        ExclusiveStartKey: inqLastKey,
      }));
      openInquiries.push(...(res.Items ?? []) as SupportInquiryItem[]);
      inqLastKey = res.LastEvaluatedKey;
    } while (inqLastKey);

    await Promise.all(openInquiries.map((inq) =>
      ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: inq.PK, SK: inq.SK },
        UpdateExpression: 'SET #status = :closed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':closed': 'CLOSED' },
      })),
    ));
  } catch (err: any) {
    console.error('[monthEndRollover] Error closing support inquiries:', err);
  }
}
