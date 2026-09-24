import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { RunningReportItem } from '../lib/entities';

// GET /getRunningReport?classId=xxx
// Auth: Cognito JWT, any signed-in FORCA member — her own report for one
// session, or null if she hasn't submitted one yet. Powers
// RunningSessionReportScreen.tsx's prefill/already-submitted state, same
// idea as StationLogRecorder.tsx reading station.logged.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const classId = event.queryStringParameters?.classId ?? '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `RUNNINGREPORT#${classId}#${callerUid}`, SK: 'METADATA' } }));
  const item = res.Item as RunningReportItem | undefined;

  return json(200, {
    report: item ? { perceivedExertion: item.perceivedExertion, averagePace: item.averagePace, loggedAt: item.loggedAt } : null,
  });
}
