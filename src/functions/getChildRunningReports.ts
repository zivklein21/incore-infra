import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { runningReportHistory } from '../lib/runningReportHistory';

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

  const result = await runningReportHistory(link.table, childUid, event.queryStringParameters ?? {});
  if (!result.ok) return json(400, { error: result.error });
  return json(200, result.body);
}
