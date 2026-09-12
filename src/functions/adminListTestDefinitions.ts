import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { TestDefinitionItem } from '../lib/entities';

// GET or POST /adminListTestDefinitions
// Auth: Cognito JWT, admin or a coach with performance:'read' — no
// trainee-facing equivalent (unlike Exercises). Admin sees drafts too (the
// Manage > Tracker > Tests & Quizzes catalog editor); a coach only sees
// active ones, matching what she's allowed to record a result against.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.performance === 'none') return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'TESTDEF#', ':metadata': 'METADATA' },
  }));

  const testDefinitions = ((res.Items ?? []) as (TestDefinitionItem & { PK: string })[])
    .filter((t) => access.isAdmin || t.active)
    .map((t) => ({
      id: t.PK.replace('TESTDEF#', ''),
      name: t.name,
      unit: t.unit ?? null,
      higherIsBetter: t.higherIsBetter,
      active: t.active,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { testDefinitions });
}
