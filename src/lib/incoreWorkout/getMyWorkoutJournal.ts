import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { israelDateStr, type ClassItem, type IncoreWorkoutLogItem, type RegistrationItem } from '../entities';
import { toWorkoutLogDto } from '../incoreExercises';

// How far back an attended-but-unlogged class keeps showing up as "waiting
// to be logged". Older ones just drop off rather than nagging forever.
const UNLOGGED_WINDOW_DAYS = 45;

async function queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

// GET /getMyWorkoutJournal
// Auth: Cognito JWT, any signed-in INCORE member — the caller's own data only.
// Returns:
//   logs              — every IncoreWorkoutLogItem the caller saved (newest first)
//   unloggedSessions  — past classes the caller was booked into (status REGISTERED,
//                       within the last UNLOGGED_WINDOW_DAYS) that have no
//                       log yet; the Workout Journal's "waiting to be logged"
//                       list. Matched by the deterministic `cls_<classId>`
//                       log id (see entities.ts's IncoreWorkoutLogItem).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  const [logItems, regItems] = await Promise.all([
    queryAll({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':prefix': 'WORKOUTLOG#' },
    }),
    queryAll({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: '#status = :registered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pk': `MEMBER#${callerUid}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
    }),
  ]);

  const logs = (logItems as unknown as IncoreWorkoutLogItem[])
    .map(toWorkoutLogDto)
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
  const loggedClassIds = new Set(logs.map((l) => l.classId).filter(Boolean));

  const now = Date.now();
  const windowStart = now - UNLOGGED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const candidates = (regItems as unknown as RegistrationItem[]).filter((r) => {
    const t = new Date(r.classDate).getTime();
    return t < now && t >= windowStart && !loggedClassIds.has(r.classId);
  });

  // Re-read the class itself rather than trusting the registration's
  // denormalized classDate alone — an admin may have moved or deleted it
  // since the booking was made.
  const classRes = await Promise.all(candidates.map((r) =>
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } }))));

  const unloggedSessions = candidates
    .map((r, i) => {
      const cls = classRes[i].Item as ClassItem | undefined;
      if (!cls) return null;
      const classDate = new Date(cls.date);
      if (classDate.getTime() >= now) return null;
      return {
        classId: r.classId,
        className: cls.className ?? '',
        classDate: classDate.toISOString(),
        date: israelDateStr(classDate),
      };
    })
    .filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => b.classDate.localeCompare(a.classDate));

  return json(200, { logs, unloggedSessions });
}
