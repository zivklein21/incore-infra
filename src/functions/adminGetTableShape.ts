import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET /adminGetTableShape
// Auth: Cognito JWT, caller must be admin
//
// Powers the Data Viewer's entity/SK filter chips — instead of a hand-
// maintained list of "known" PK/SK prefixes (which drifts out of sync the
// moment a new entity type or SK shape is added to the codebase and nobody
// remembers to update the admin portal too), this derives the real,
// complete set directly from the table's actual contents. A PK/SK "shape"
// is everything up to and including the first '#' (e.g. 'MEMBER#<uid>' ->
// 'MEMBER#', 'REG#<uid>' -> 'REG#'); PK/SK values with no '#' (e.g.
// 'APPCONFIG', 'METADATA') are their own whole shape.
//
// Does a full, unpaginated Scan projecting only PK/SK — safe at this
// table's documented <=50-user scale (dynamodb.tf), same tradeoff already
// accepted by lib/memberScan.ts and friends. Revisit (e.g. cache this, or
// maintain a GSI of shapes) if the table ever grows past that.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const entities = new Map<string, { count: number; skShapes: Map<string, number> }>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastKey,
    }));

    for (const item of (res.Items ?? []) as { PK: string; SK: string }[]) {
      const pkShape = shapeOf(item.PK);
      const skShape = shapeOf(item.SK);

      if (!entities.has(pkShape)) entities.set(pkShape, { count: 0, skShapes: new Map() });
      const entity = entities.get(pkShape)!;
      entity.count += 1;
      entity.skShapes.set(skShape, (entity.skShapes.get(skShape) ?? 0) + 1);
    }

    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  const result = Array.from(entities.entries())
    .map(([pkPrefix, { count, skShapes }]) => ({
      pkPrefix,
      count,
      skShapes: Array.from(skShapes.entries())
        .map(([skPrefix, skCount]) => ({ skPrefix, count: skCount }))
        .sort((a, b) => b.count - a.count || a.skPrefix.localeCompare(b.skPrefix)),
    }))
    .sort((a, b) => b.count - a.count || a.pkPrefix.localeCompare(b.pkPrefix));

  return json(200, { entities: result });
}

function shapeOf(key: string): string {
  const hashIndex = key.indexOf('#');
  return hashIndex === -1 ? key : key.slice(0, hashIndex + 1);
}
