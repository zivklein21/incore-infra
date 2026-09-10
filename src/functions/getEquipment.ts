import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { EquipmentItem } from '../lib/entities';

// GET or POST /getEquipment
// Auth: Cognito JWT (any signed-in member)
// FORCA-only — gear inventory (name/quantity/outCount), see adminSaveEquipment.ts.
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'EQUIPMENT#', ':metadata': 'METADATA' },
  }));

  const equipment = ((res.Items ?? []) as EquipmentItem[])
    .map((e) => ({
      id: e.PK.replace('EQUIPMENT#', ''),
      name: e.name ?? '',
      quantity: e.quantity ?? 0,
      outCount: e.outCount ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { equipment });
}
