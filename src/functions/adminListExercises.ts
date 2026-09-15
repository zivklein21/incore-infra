import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { ExerciseDefinitionItem } from '../lib/entities';

// GET or POST /adminListExercises
// Auth: Cognito JWT, admin or a coach with workoutPlans:'read' or 'write' —
// see adminSaveExercise.ts. Every exercise, draft and published — the
// Backoffice list view (both admin and coach see drafts here, unlike
// adminListWorkoutPlans.ts's admin-only-drafts split, since a coach with
// workoutPlans:'write' is expected to author exercises herself). See
// getExercises.ts for the trainee-facing (active-only) equivalent.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans === 'none') return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'EXERCISE#', ':metadata': 'METADATA' },
  }));

  const exercises = ((res.Items ?? []) as (ExerciseDefinitionItem & { PK: string })[])
    .map((e) => ({
      id: e.PK.replace('EXERCISE#', ''),
      name: e.name,
      category: e.category ?? '',
      measurementType: e.measurementType,
      bandLevels: e.bandLevels ?? [],
      equipment: e.equipment ?? [],
      active: e.active,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { exercises });
}
