import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ddb, TABLE_NAME } from '../dynamo';
import { json } from '../http';
import { queryCatalog, toExerciseDto } from '../incoreExercises';

// GET /getIncoreExercises
// Auth: Cognito JWT, any signed-in INCORE member. Active (published)
// catalog exercises only — what the trainee's Workout Journal exercise
// picker offers. Image URLs are short-lived signed GETs (15 min), same as
// getForcaMerchProducts.ts; the client re-fetches well inside that window.
export async function handler(
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const items = (await queryCatalog(ddb, TABLE_NAME)).filter((e) => e.active);
  const exercises = (await Promise.all(items.map(toExerciseDto)))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));

  return json(200, { exercises });
}
