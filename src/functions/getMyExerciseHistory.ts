import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ExerciseLogEntryItem } from '../lib/entities';

// GET or POST /getMyExerciseHistory
// Query/body: { exerciseId?: string } — omit for everything she's ever logged
// Auth: Cognito JWT, any signed-in FORCA member — her own entries only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let exerciseId = event.queryStringParameters?.exerciseId ?? '';
  if (!exerciseId && event.body) {
    try {
      const body = JSON.parse(event.body) as { exerciseId?: unknown };
      exerciseId = typeof body.exerciseId === 'string' ? body.exerciseId : '';
    } catch { /* ignore */ }
  }

  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `MEMBER#${callerUid}`,
      ':skPrefix': exerciseId ? `EXERCISELOG#${exerciseId}#` : 'EXERCISELOG#',
    },
  }));

  const entries = ((res.Items ?? []) as (ExerciseLogEntryItem & { PK: string })[])
    .map((e) => ({
      id: e.PK.replace('EXERCISELOG#', ''),
      exerciseId: e.exerciseId,
      exerciseName: e.exerciseName,
      measurementType: e.measurementType,
      value: e.value,
      loggedAt: e.loggedAt,
    }))
    .sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));

  return json(200, { entries });
}
