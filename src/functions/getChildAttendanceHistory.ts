import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { verifyFamilyLink } from '../lib/familyLinks';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// GET or POST /getChildAttendanceHistory?childUid=xxx
// Auth: Cognito JWT, caller must be childUid's linked parent (verifyFamilyLink)
//
// Parent-session (no identity switch) counterpart of getMyAttendanceHistory.ts
// — see the FORCA Child Switcher plan. Same direct-Scan-for-her-REG#<uid>-
// sort-keys approach, just authorized via the family link instead of "this
// is my own uid".
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const childUid = event.queryStringParameters?.childUid;
  if (!childUid) return json(400, { error: 'missing_child_uid' });

  const link = await verifyFamilyLink(callerUid, childUid);
  if (!link.ok) return json(403, { error: 'forbidden' });

  const regsRes = await ddb.send(new ScanCommand({
    TableName: link.table,
    FilterExpression: 'SK = :sk',
    ExpressionAttributeValues: { ':sk': `REG#${childUid}` },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  if (registrations.length === 0) return json(200, { sessions: [] });

  const sessionResults = await Promise.all(registrations.map((r) =>
    ddb.send(new GetCommand({ TableName: link.table, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } })),
  ));

  const nowIso = new Date().toISOString();
  const sessions = registrations
    .map((r, i) => {
      const session = sessionResults[i].Item as ClassItem | undefined;
      if (!session || session.date >= nowIso) return null;
      return {
        classId: r.classId,
        date: session.date,
        className: session.className ?? '',
        declaredAttendance: r.declaredAttendance ?? 'pending',
        declineReason: r.declineReason || null,
        actualAttendance: r.actualAttendance ?? null,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  return json(200, { sessions });
}
