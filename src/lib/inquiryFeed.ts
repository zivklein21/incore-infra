import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';

// Support inquiry lists (admin INCORE, admin FORCA, coach FORCA).
//
// Each inquiry's METADATA item sits in one GSI2 partition per brand:
// FORCA GSI2PK='FORCAINQUIRY' (since createForcaSupportInquiry), INCORE
// GSI2PK='SUPPORTINQUIRY' (createSupportInquiry from 1.5.2 on;
// scripts/backfillInquiryIndex.ts adds it to older ones). Reading that
// partition replaces a whole-table Scan that the tab bars ran every 15 s for
// their unread badge.
//
// ?paged=1 → every OPEN inquiry (an open conversation is never hidden behind
// Load more, so the badge and the Open filter stay complete) plus CLOSED ones
// whose last activity falls in the 2-month window; Load more pages back
// through closed ones only.

export const INCORE_INQUIRY_GSI2PK = 'SUPPORTINQUIRY';
export const FORCA_INQUIRY_GSI2PK = 'FORCAINQUIRY';

export async function queryInquiryPartition<T>(table: string, gsi2pk: string): Promise<T[]> {
  const out: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': gsi2pk },
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as T[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** Legacy full read for builds already in the stores; follows every Scan page. */
export async function scanInquiries<T>(table: string, pkPrefix: string): Promise<T[]> {
  const out: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': pkPrefix, ':metadata': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as T[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

// The paging rule itself (open always on page 1) lives in lib/inquiryPaging.ts.
export { pageInquiries, sortInquiries } from './inquiryPaging';
