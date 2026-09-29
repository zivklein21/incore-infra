import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { MeasurementTypeItem } from '../lib/entities';

// GET or POST /getMeasurementTypes
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write' — same gate
// as the Exercise Pool this feeds (see adminSaveExercise.ts). FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'MEASUREMENTTYPE#', ':metadata': 'METADATA' },
  }));

  const measurementTypes = ((res.Items ?? []) as MeasurementTypeItem[])
    .map((m) => ({ id: m.PK.replace('MEASUREMENTTYPE#', ''), name: m.name, baseType: m.baseType }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { measurementTypes });
}
