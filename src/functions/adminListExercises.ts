import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ExerciseDefinitionItem } from '../lib/entities';

// GET or POST /adminListExercises
// Auth: Cognito JWT, caller must be admin
// Every exercise, draft and published — the Backoffice list view. See
// getExercises.ts for the trainee-facing (active-only) equivalent.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'EXERCISE#', ':metadata': 'METADATA' },
  }));

  const exercises = ((res.Items ?? []) as (ExerciseDefinitionItem & { PK: string })[])
    .map((e) => ({
      id: e.PK.replace('EXERCISE#', ''),
      name: e.name,
      measurementType: e.measurementType,
      bandLevels: e.bandLevels ?? [],
      active: e.active,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { exercises });
}
