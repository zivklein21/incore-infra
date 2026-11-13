import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { runningReportHistory } from '../lib/runningReportHistory';

// GET or POST /getMyRunningReports
// Auth: Cognito JWT, any signed-in FORCA member — her own running-session
// reports only, newest first. Same GSI1 "everything she's ever logged"
// query getMyExerciseHistory.ts already uses for ExerciseLogEntryItem —
// RunningReportItem's own GSI1PK/GSI1SK were populated with exactly this
// future view in mind (see entities.ts's own comment on that item).
// Powers PerformanceScreen.tsx's "ריצות" tab.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const result = await runningReportHistory(FORCA_TABLE_NAME, callerUid, event.queryStringParameters ?? {});
  if (!result.ok) return json(400, { error: result.error });
  return json(200, result.body);
}
