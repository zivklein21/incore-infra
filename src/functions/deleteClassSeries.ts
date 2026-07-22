import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem } from '../lib/entities';

// POST /deleteClassSeries
// Auth: Cognito JWT, caller must be admin
// Body: { seriesId: string, fromDate: string (ISO) }
//
// Deletes every class in the series with date >= fromDate — the "delete
// this and future" behavior from the old Firestore useClassDetails.ts.
// Scan-based, same as getClasses.ts and for the same reason: there's no
// series_id index (a series is a handful of weekly-repeated classes, not a
// large collection — a full scan here is proportionate to that scale, not
// the same concern as scanning for every class in the table repeatedly).
// BatchWriteCommand caps at 25 items per call; series are weekly-repeated
// within a single month (see createClass.ts's client-side loop), so this
// will never need more than one batch in practice, but chunks anyway.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);
  if (!(await isAdmin(uid))) return json(403, { error: 'forbidden' });

  let body: { seriesId?: unknown; fromDate?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const seriesId = typeof body.seriesId === 'string' ? body.seriesId.trim() : '';
  const fromDate = typeof body.fromDate === 'string' ? new Date(body.fromDate) : null;
  if (!seriesId || !fromDate || Number.isNaN(fromDate.getTime())) {
    return json(400, { error: 'missing_fields', required: ['seriesId', 'fromDate'] });
  }

  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND series_id = :seriesId',
    ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA', ':seriesId': seriesId },
  }));
  const items = ((res.Items ?? []) as (ClassItem & { series_id?: string })[])
    .filter((c) => new Date(c.date).getTime() >= fromDate.getTime());

  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk.map((c) => ({ DeleteRequest: { Key: { PK: c.PK, SK: 'METADATA' } } })),
      },
    }));
  }

  return json(200, { success: true, deletedCount: items.length });
}
