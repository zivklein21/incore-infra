import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import { decodeWindowCursor, queryDateWindow } from './datePaging';
import type { RunningReportItem } from './entities';

// A trainee's RPE/pace running reports — shared by getMyRunningReports (own)
// and getChildRunningReports (parent, family-link authorized). Rows come off
// GSI1PK=MEMBER#<uid>, GSI1SK=RUNNINGREPORT#<loggedAt>#<classId>.
//
// ?paged=1 (app 1.5.2+): the last 2 months, then 2 months per Load more
// (lib/datePaging.ts) → { reports, nextCursor, coveredFrom }.
// Without it: every report, unchanged, for builds already in the stores.

const SK_PREFIX = 'RUNNINGREPORT#';

function toRow(r: RunningReportItem) {
  return {
    classId: r.classId,
    perceivedExertion: r.perceivedExertion,
    averagePace: r.averagePace,
    loggedAt: r.loggedAt,
  };
}

export type RunningReportHistoryResult =
  | { ok: true; body: { reports: ReturnType<typeof toRow>[]; nextCursor?: string | null; coveredFrom?: string } }
  | { ok: false; error: 'invalid_cursor' };

export async function runningReportHistory(
  table: string, uid: string, qs: Record<string, string | undefined>,
): Promise<RunningReportHistoryResult> {
  if (qs.paged !== '1' && qs.paged !== 'true') {
    const items: RunningReportItem[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: table,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
        ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':skPrefix': SK_PREFIX },
        ExclusiveStartKey: lastKey,
      }));
      items.push(...((res.Items ?? []) as RunningReportItem[]));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return { ok: true, body: { reports: items.map(toRow).sort((a, b) => b.loggedAt.localeCompare(a.loggedAt)) } };
  }

  const cursor = qs.cursor ? decodeWindowCursor(qs.cursor, SK_PREFIX) : null;
  if (qs.cursor && !cursor) return { ok: false, error: 'invalid_cursor' };

  const page = await queryDateWindow<RunningReportItem & Record<string, unknown>, ReturnType<typeof toRow>>({
    table,
    indexName: 'GSI1',
    pkName: 'GSI1PK',
    pkValue: `MEMBER#${uid}`,
    skName: 'GSI1SK',
    skPrefix: SK_PREFIX,
    cursor,
    process: async (items) => items.map(toRow),
  });
  return { ok: true, body: { reports: page.items, nextCursor: page.nextCursor, coveredFrom: page.coveredFrom } };
}
