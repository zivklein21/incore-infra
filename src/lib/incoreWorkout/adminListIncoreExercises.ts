import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import { queryCatalog, toExerciseDto } from '../incoreExercises';

// GET or POST /adminListIncoreExercises
// Auth: Cognito JWT, admin only. Every INCORE catalog exercise, drafts
// (active: false) included — the Backoffice list view. See
// getIncoreExercises.ts for the trainee-facing active-only equivalent.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(getUid(event)))) return json(403, { error: 'forbidden' });

  const items = await queryCatalog(ddb, TABLE_NAME);
  const exercises = (await Promise.all(items.map(toExerciseDto)))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));

  return json(200, { exercises });
}
