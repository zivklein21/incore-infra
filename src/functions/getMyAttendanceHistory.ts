import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// GET or POST /getMyAttendanceHistory
// Auth: Cognito JWT, any signed-in FORCA member — her own past training
// session attendance (declared vs. actual), newest first. FORCA-only; an
// INCORE caller simply has no REG#<uid> items in this table and gets an
// empty list back.
//
// Unlike getTrainingHistory.ts (admin, every session + every trainee's
// roster via resolveSessionDetail/CoachAccess), this only needs the
// caller's own registrations — a direct Scan for her REG#<uid> sort keys
// avoids pulling in the coach-scoping/equipment machinery entirely. Same
// accepted Scan tradeoff as getTrainingHistory.ts at this app's documented
// <=50-users-per-brand scale.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const uid = getUid(event);

  const regsRes = await ddb.send(new ScanCommand({
    TableName: FORCA_TABLE_NAME,
    FilterExpression: 'SK = :sk',
    ExpressionAttributeValues: { ':sk': `REG#${uid}` },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];
  if (registrations.length === 0) return json(200, { sessions: [] });

  const sessionResults = await Promise.all(registrations.map((r) =>
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } })),
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
