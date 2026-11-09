import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import type { ClassItem, RegistrationItem } from './entities';

// A member's registrations, read off her own GSI1 partition
// (GSI1PK=MEMBER#<uid>, GSI1SK=REG#… — INCORE writes REG#<month>#<classId>,
// FORCA REG##<classId>), plus the class items they point at. Replaces the
// whole-table Scans the attendance history endpoints used to do (which also
// stopped after DynamoDB's first 1 MB page and silently dropped sessions once
// the table outgrew it). scripts/backfillRegistrationIndex.ts fills in GSI1 on
// any registration written before every writer set it.

export async function queryMemberRegistrations(table: string, uid: string): Promise<RegistrationItem[]> {
  const out: RegistrationItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': 'REG#' },
      ExclusiveStartKey: lastKey,
    }));
    for (const it of (res.Items ?? []) as RegistrationItem[]) {
      if (String(it.SK).startsWith('REG#')) out.push(it);
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  // One registration per class; keep the first if old data has duplicates.
  const seen = new Set<string>();
  return out.filter((r) => (r.classId && !seen.has(r.classId) ? (seen.add(r.classId), true) : false));
}

export async function batchGetClasses(table: string, classIds: string[]): Promise<Map<string, ClassItem>> {
  const out = new Map<string, ClassItem>();
  const ids = [...new Set(classIds)];
  for (let i = 0; i < ids.length; i += 100) {
    let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + 100).map((id) => ({ PK: `CLASS#${id}`, SK: 'METADATA' }));
    // BatchGet may hand back part of the request as UnprocessedKeys under load.
    for (let attempt = 0; keys && keys.length > 0 && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
      for (const item of (res.Responses?.[table] ?? []) as ClassItem[]) {
        out.set(String(item.PK).replace('CLASS#', ''), item);
      }
      keys = res.UnprocessedKeys?.[table]?.Keys as Record<string, unknown>[] | undefined;
      if (keys && keys.length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
  return out;
}

/** `?paged=1` from app 1.5.2 on; older builds get the full list as before. */
export function isPagedRequest(qs: Record<string, string | undefined> | undefined): boolean {
  return qs?.paged === '1' || qs?.paged === 'true';
}
