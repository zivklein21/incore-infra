import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { RunningReportItem } from '../lib/entities';

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

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':skPrefix': 'RUNNINGREPORT#' },
  }));

  const reports = ((res.Items ?? []) as RunningReportItem[])
    .map((r) => ({
      classId: r.classId,
      perceivedExertion: r.perceivedExertion,
      averagePace: r.averagePace,
      loggedAt: r.loggedAt,
    }))
    .sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));

  return json(200, { reports });
}
