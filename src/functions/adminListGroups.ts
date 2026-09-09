import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { GroupItem } from '../lib/entities';

// GET or POST /adminListGroups
// Auth: Cognito JWT, caller must be admin
// FORCA-only. Table documented for <=50 users per brand (dynamodb.tf) —
// same accepted Scan tradeoff as getClassTypes.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
  }));

  const groups = ((res.Items ?? []) as GroupItem[])
    .map((g) => ({
      id: g.PK.replace('GROUP#', ''),
      name: g.name,
      description: g.description ?? '',
      price: g.price ?? null,
      sessionsPerWeek: g.sessionsPerWeek ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { groups });
}
