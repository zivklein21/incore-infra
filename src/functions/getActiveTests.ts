import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import type { TestDefinitionItem } from '../lib/entities';

// GET or POST /getActiveTests
// Auth: Cognito JWT (any signed-in FORCA member) — the trainee/parent-facing
// Tests & Quizzes picker, mirrors getExercises.ts. Only active:true test
// definitions are returned; drafts stay admin-only (adminListTestDefinitions.ts).
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND active = :active',
    ExpressionAttributeValues: { ':prefix': 'TESTDEF#', ':metadata': 'METADATA', ':active': true },
  }));

  const tests = ((res.Items ?? []) as (TestDefinitionItem & { PK: string })[])
    .map((t) => ({
      id: t.PK.replace('TESTDEF#', ''),
      name: t.name,
      unit: t.unit ?? null,
      higherIsBetter: t.higherIsBetter,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { tests });
}
