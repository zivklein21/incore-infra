import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { WorkoutPackageTypeItem } from '../lib/entities';

// GET or POST /getWorkoutPackageTypes
// Auth: Cognito JWT, admin or a coach with workoutPlans:'read' or 'write' —
// same gate as adminListWorkoutPlans.ts, since this only feeds that
// builder's Package dropdown. FORCA-only.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans === 'none') return json(403, { error: 'forbidden' });

  const res = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
    ExpressionAttributeValues: { ':prefix': 'WORKOUTPACKAGE#', ':metadata': 'METADATA' },
  }));

  const packageTypes = ((res.Items ?? []) as WorkoutPackageTypeItem[])
    .map(p => ({ id: p.PK.replace('WORKOUTPACKAGE#', ''), name: p.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { packageTypes });
}
