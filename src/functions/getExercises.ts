import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { ExerciseDefinitionItem } from '../lib/entities';

// GET or POST /getExercises
// Auth: Cognito JWT (any signed-in FORCA member) — the trainee's own
// exercise picker. Only active:true exercises are returned; drafts stay
// admin-only (see adminListExercises.ts).
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND active = :active',
    ExpressionAttributeValues: { ':prefix': 'EXERCISE#', ':metadata': 'METADATA', ':active': true },
  }));

  const exercises = ((res.Items ?? []) as (ExerciseDefinitionItem & { PK: string })[])
    .map((e) => ({
      id: e.PK.replace('EXERCISE#', ''),
      name: e.name,
      measurementType: e.measurementType,
      bandLevels: e.bandLevels ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { exercises });
}
