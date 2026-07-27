import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET /adminQueryTableItems?entityPrefix=PRODUCT%23&skPrefix=METADATA&limit=25&cursor=<base64>
// Auth: Cognito JWT, caller must be admin
//
// Powers the DynamoDB Table Data Viewer's paginated list. entityPrefix
// filters on PK begins_with (e.g. 'PRODUCT#', 'CLASS#', 'MEMBER#'); omit it
// to browse the whole table unfiltered. skPrefix additionally filters on SK
// begins_with — several entity types share a PK prefix across more than one
// SK "shape" (e.g. MEMBER#<uid> holds both SK='PROFILE' and
// SK='CANCEL#<classId>' items; CLASS#<id> holds SK='METADATA' and
// SK='REG#<uid>'), so entityPrefix alone can mix unrelated row shapes in
// one page — skPrefix narrows to just one. This is a Scan+FilterExpression,
// not a Query — there's no GSI keyed by entity type today (see
// getClasses.ts's identical tradeoff note), acceptable here because this
// endpoint is admin-only, paginated in small pages, and not on any
// member-facing hot path. cursor is the caller's own LastEvaluatedKey from
// the previous page, base64-encoded so it's an opaque string over HTTP.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const q = event.queryStringParameters ?? {};
  const entityPrefix = q.entityPrefix?.trim();
  const skPrefix = q.skPrefix?.trim();
  const limitParam = Number(q.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25;

  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (q.cursor) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(q.cursor, 'base64').toString('utf8'));
    } catch {
      return json(400, { error: 'invalid_cursor' });
    }
  }

  const filterClauses: string[] = [];
  const filterValues: Record<string, string> = {};
  if (entityPrefix) {
    filterClauses.push('begins_with(PK, :pkPrefix)');
    filterValues[':pkPrefix'] = entityPrefix;
  }
  if (skPrefix) {
    filterClauses.push('begins_with(SK, :skPrefix)');
    filterValues[':skPrefix'] = skPrefix;
  }

  const res = await ddb.send(new ScanCommand({
    TableName: TABLE_NAME,
    Limit: limit,
    ExclusiveStartKey: exclusiveStartKey,
    ...(filterClauses.length > 0 ? {
      FilterExpression: filterClauses.join(' AND '),
      ExpressionAttributeValues: filterValues,
    } : {}),
  }));

  const nextCursor = res.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString('base64')
    : null;

  // Note for API consumers: with entityPrefix set, `items` can be shorter
  // than `limit` (even empty) while nextCursor is still non-null — DynamoDB
  // applies Limit to items *scanned*, not items remaining after
  // FilterExpression. Keep paging while nextCursor is non-null rather than
  // stopping once `items` looks sparse.
  return json(200, { items: res.Items ?? [], nextCursor });
}
