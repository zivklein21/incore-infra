import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { ADMIN_LOG_VIEWER_FUNCTIONS, functionKeyToLogGroup } from '../lib/adminConfig';

// GET /adminListLogGroups
// Auth: Cognito JWT, caller must be admin
// Feeds the Logs Viewer screen's function picker. Static allowlist (see
// adminConfig.ts) rather than a CloudWatch DescribeLogGroups call — cheaper
// and means new functions don't show up in the admin logs UI until someone
// deliberately decides they're worth exposing there.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const functions = ADMIN_LOG_VIEWER_FUNCTIONS.map((key) => ({
    functionName: key,
    logGroupName: functionKeyToLogGroup(key),
  }));

  return json(200, { functions });
}
