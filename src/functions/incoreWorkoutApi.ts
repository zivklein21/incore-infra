import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { json } from '../lib/http';
import { handler as adminListIncoreExercises } from '../lib/incoreWorkout/adminListIncoreExercises';
import { handler as adminSaveIncoreExercise } from '../lib/incoreWorkout/adminSaveIncoreExercise';
import { handler as adminDeleteIncoreExercise } from '../lib/incoreWorkout/adminDeleteIncoreExercise';
import { handler as adminSeedIncoreExercises } from '../lib/incoreWorkout/adminSeedIncoreExercises';
import { handler as getIncoreExercises } from '../lib/incoreWorkout/getIncoreExercises';
import { handler as getMyWorkoutJournal } from '../lib/incoreWorkout/getMyWorkoutJournal';
import { handler as saveMyWorkoutLog } from '../lib/incoreWorkout/saveMyWorkoutLog';
import { handler as deleteMyWorkoutLog } from '../lib/incoreWorkout/deleteMyWorkoutLog';
import { handler as adminListFormTemplates } from '../lib/formTemplates/adminListFormTemplates';
import { handler as adminSaveFormTemplate } from '../lib/formTemplates/adminSaveFormTemplate';
import { handler as adminDeleteFormTemplate } from '../lib/formTemplates/adminDeleteFormTemplate';

type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyStructuredResultV2>;

// Keys must match locals.tf's incore_workout_routes exactly.
const HANDLERS: Record<string, Handler> = {
  adminListIncoreExercises,
  adminSaveIncoreExercise,
  adminDeleteIncoreExercise,
  adminSeedIncoreExercises,
  getIncoreExercises,
  getMyWorkoutJournal,
  saveMyWorkoutLog,
  deleteMyWorkoutLog,
  // Not workout-related — Manage → Forms → Form Templates. Rides this
  // Lambda's integration for the same 300-integration-cap reason.
  adminListFormTemplates,
  adminSaveFormTemplate,
  adminDeleteFormTemplate,
};

// Single Lambda behind every INCORE Exercise Catalog + Workout Journal
// endpoint (see the handlers under lib/incoreWorkout/ for each one's
// contract). Exists because this HTTP API sits at AWS's hard cap of 300
// integrations, and every standalone Lambda costs one: API Gateway lets
// many routes share one integration, so these 8 routes (locals.tf's
// incore_workout_routes, api_gateway.tf's aws_apigatewayv2_route
// .incore_workout) all target this function's single integration, which
// dispatches on the matched route's path. The client still calls the same
// /<name> URLs as if each were its own function.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  // routeKey is e.g. "POST /saveMyWorkoutLog" — the route template that
  // matched, not the raw path, so it's immune to stage prefixes.
  const name = event.routeKey.split(' /')[1] ?? '';
  const target = HANDLERS[name];
  if (!target) return json(404, { error: 'not_found' });
  return target(event);
}
