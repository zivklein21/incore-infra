import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMemberWeeklyTaskHistory } from '../lib/weeklyTaskHistory';

// GET or POST /getMyWeeklyTaskHistory
// Auth: Cognito JWT, any signed-in FORCA member — her own full weekly-task
// history (active or not, completed or not), deadline-descending. This is
// the FORCA Tracker's own "Weekly Tasks" review tab (see
// resolveMemberWeeklyTaskHistory) — distinct from getMyWeeklyTasks.ts,
// which is active-tasks-only and powers the Home dashboard's do-it-now card.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const tasks = await resolveMemberWeeklyTaskHistory(FORCA_TABLE_NAME, callerUid);
  return json(200, { tasks });
}
