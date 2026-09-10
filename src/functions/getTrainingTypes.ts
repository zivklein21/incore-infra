import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { TrainingTypeItem } from '../lib/entities';

// GET or POST /getTrainingTypes
// Auth: Cognito JWT (any signed-in member)
// FORCA-only — see getClassTypes.ts for the INCORE equivalent.
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'TRAININGTYPE#', ':metadata': 'METADATA' },
  }));

  const trainingTypes = ((res.Items ?? []) as TrainingTypeItem[])
    .map((t) => ({
      id: t.PK.replace('TRAININGTYPE#', ''),
      name: t.name ?? '',
      durationMinutes: t.durationMinutes ?? null,
      equipmentRequirements: t.equipmentRequirements ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { trainingTypes });
}
