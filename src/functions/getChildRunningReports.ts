import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { RunningReportItem } from '../lib/entities';

// GET or POST /getChildRunningReports?childUid=xxx
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of getMyRunningReports.ts
// — lets a parent follow her daughter's running-session report history from
// her own account, same "read-only, logging stays the trainee's own action"
// convention as getChildExerciseHistory.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: link.table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :skPrefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${childUid}`, ':skPrefix': 'RUNNINGREPORT#' },
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
