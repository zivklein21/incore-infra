import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ExerciseLogEntryItem } from '../lib/entities';

// GET or POST /getChildExerciseHistory?childUid=xxx&exerciseId=yyy
// exerciseId is optional — omit for everything she's ever logged.
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of getMyExerciseHistory.ts
// — lets a parent follow her daughter's FORCA Tracker progress from her own
// account. Read-only by design: logging a result stays the trainee's own
// action (logExercise.ts), not something a parent does on her behalf.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const exerciseId = event.queryStringParameters?.exerciseId ?? '';

  const res = await ddb.send(new QueryCommand({
    TableName: link.table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `MEMBER#${childUid}`,
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
