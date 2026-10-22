// EventBridge Scheduled Rule — unix-cron "59 23 28-31 * *" (23:59 on days
// 28-31), Asia/Jerusalem; exits immediately unless today is the actual last
// day of the month.
import { ScanCommand, GetCommand, UpdateCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import type { MembershipItem, SupportInquiryItem } from '../lib/entities';
import { monthKey, endOfMonth } from '../lib/entities';

export async function handler(): Promise<void> {
  const now = new Date();

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (tomorrow.getMonth() === now.getMonth()) {
    console.log('[monthEndRollover] Not the last day of the month — exiting');
    return;
  }

  const currentMonth = monthKey(now);
  console.log(`[monthEndRollover] month=${currentMonth} — starting`);

  // A standard subscription gets a brand-new MembershipItem each month (see
  // handlePaymentSuccess), so matching on targetMonth === currentMonth alone
  // is enough to find it exactly once. A CUSTOM_MIGRATION item is the same
  // item for its whole custom-duration period — its targetMonth only ever
  // reflects the month it started, so it must also be matched by type here
  // or it would only ever be inspected once, in its first month, and never
  // revisited to check whether its own endDate has since passed.
  const memberships: MembershipItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :prefix) AND #status = :active AND (targetMonth = :month OR #type = :customMigration)',
      ExpressionAttributeNames: { '#status': 'status', '#type': 'type' },
      ExpressionAttributeValues: { ':prefix': 'MEMBERSHIP#', ':active': 'ACTIVE', ':month': currentMonth, ':customMigration': 'CUSTOM_MIGRATION' },
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

      // Month-end no longer turns unused sessions into credit — that happens
      // only in the Thursday job (weekendSessionsRoutine), once per week, so a
      // week spanning the month end (e.g. Sun 27/9–Sat 3/10) is settled once,
      // on its Thursday, and never twice. Usage is left as-is: the Thursday
      // job still needs it to settle that last week. Sessions left on a
      // closed membership are simply gone (shown as 0 left in the app).
      const newMonthEndProcessed = { ...fresh.monthEndProcessed, [currentMonth]: true };

      // A custom-duration membership (e.g. a 6-week admin migration bridge)
      // can extend past this calendar month's end — only close it out once
      // its own endDate has actually passed. Missing endDate falls back to
      // the old unconditional-expiry behavior rather than staying active
      // forever on bad data.
      const stillActive = isCustomMigration && !!fresh.endDate && new Date(fresh.endDate) > endOfMonth(now);

      // usage is a DynamoDB reserved keyword — bare here it fails every call.
      let memUpdateExpr: string;
      const memValues: Record<string, unknown> = { ':mep': newMonthEndProcessed, ':now': nowIso };
      if (stillActive) {
        // Condition B — keep ACTIVE. There's no fresh MembershipItem created
        // for it next month like a normal subscription gets (it's the same
        // item for its whole custom period), so its monthly counters are reset
        // in place instead. weeklyUsage is kept: weeks are keyed by their own
        // date, and a week spanning the month end still needs last month's part.
        memUpdateExpr = 'SET monthEndProcessed = :mep, updatedAt = :now, #usage = :freshUsage';
        memValues[':freshUsage'] = { totalMonthlyUsed: 0, legalCancellationsUsed: 0, lateCancellationsUsed: 0, rolledToCredit: 0 };
        rolledOver++;
      } else if (isCustomMigration) {
        // Condition A — past its own endDate (or missing one): close it out.
        memUpdateExpr = 'SET monthEndProcessed = :mep, #status = :expired, updatedAt = :now';
        memValues[':expired'] = 'expired';
        locked++;
      } else {
        // Regular subscription — closed by billing (renewal replaces it, a
        // failed charge expires it); here it's only marked processed.
        memUpdateExpr = 'SET monthEndProcessed = :mep, updatedAt = :now';
        locked++;
      }

      const names: Record<string, string> = {};
      if (memUpdateExpr.includes('#status')) names['#status'] = 'status';
      if (memUpdateExpr.includes('#usage')) names['#usage'] = 'usage';
      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
        Update: {
          TableName: TABLE_NAME,
          Key: { PK: mem.PK, SK: mem.SK },
          UpdateExpression: memUpdateExpr,
          // DynamoDB rejects unused names/values — only what this branch uses.
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
          ExpressionAttributeValues: memValues,
        },
      }];

      await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

      if (isCustomMigration && !stillActive) {
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

  console.log(`[monthEndRollover] month=${currentMonth} done — continuing=${rolledOver} closed=${locked} skipped=${skipped} errors=${errors}`);

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
