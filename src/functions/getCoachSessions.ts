import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, sessionInAccess } from '../lib/coachAccess';
import { fetchSessionLookups, resolveSessionDetail } from '../lib/sessionDetail';
import type { ClassItem } from '../lib/entities';

// GET or POST /getCoachSessions
// Auth: Cognito JWT, caller must be a coach (attendance permission != 'none')
// or admin (see getCoachAccess.ts) — results are scoped to sessions actually
// assigned to her (both her group AND her coachId — see sessionInAccess()),
// not every session in a group she happens to share with other coaches. An
// admin sees everything, unrestricted. medicalFlag is stripped when she has
// no healthDeclarations permission.
//
// Lists every FORCA training session (a ClassItem with a groupId — see
// createTrainingSession.ts), past and future, with its full roster and
// equipment pack list — see lib/sessionDetail.ts's resolveSessionDetail()
// for the shared computation (also reused by getTrainingHistory.ts, which
// filters to only past sessions and adds a declared-vs-actual discrepancy
// check per roster entry). This is also what the FORCA admin Home dashboard
// reuses (via useCoachSessions(), filtered/sorted client-side) — no separate
// endpoint. View-only except for markActualAttendance.ts /
// toggleSessionEquipment.ts / returnSessionEquipment.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.attendance === 'none') return json(403, { error: 'forbidden' });

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getClasses.ts.
  const sessionsRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND attribute_exists(groupId)',
    ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA' },
  }));
  const allSessionItems = (sessionsRes.Items ?? []) as (ClassItem & { PK: string })[];
  const sessionItems = allSessionItems.filter((s) => sessionInAccess(access, s, callerUid));

  const lookups = await fetchSessionLookups(sessionItems);
  const sessions = await Promise.all(sessionItems.map((session) => resolveSessionDetail(session, lookups, access)));

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  return json(200, { sessions });
}
