import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import { resolveMemberWeeklyTaskHistory } from '../lib/weeklyTaskHistory';

// GET or POST /getChildWeeklyTaskHistory?childUid=xxx
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of getMyWeeklyTaskHistory.ts
// — lets a parent follow her daughter's weekly-task completion history from
// her own account, same convention as getChildExerciseHistory.ts. Read-only:
// completing a task stays the trainee's own action.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const tasks = await resolveMemberWeeklyTaskHistory(link.table, childUid);
  return json(200, { tasks });
}
