import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchGetCommand, BatchWriteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { isCoachOrAdmin } from '../auth';
import type { IncoreExerciseMetric, IncoreWorkoutLogItem } from '../entities';

// "Last working weight" per member + exercise.
//
// PK=MEMBER#<uid> SK=EXLAST#<exerciseId> holds a copy of that exercise's
// sets from the member's most recent log containing it (latest date, then
// latest updatedAt). Reads are key lookups by member + exercise (BatchGet), or
// one Query on the EXLAST# prefix for "all exercises", never a table scan.
//
// The pointers are derived data. saveMyWorkoutLog / deleteMyWorkoutLog call
// refreshLastWeights() for the exercises they touched, which re-derives those
// pointers from the member's own WORKOUTLOG# rows (one partition Query, a few
// hundred small items at most). Logs saved before this existed have no
// pointers: the first read for a member without the BUILT marker rebuilds all
// of them once, so no table-wide backfill is needed.

export const LAST_PREFIX = 'EXLAST#';
export const BUILT_SK = `${LAST_PREFIX}~built`;
const MAX_IDS = 60;

export interface LastWeight {
  exerciseId: string;
  exerciseName: string;
  metrics: IncoreExerciseMetric[];
  sets: Record<string, number>[];
  /** YYYY-MM-DD of the log these sets came from. */
  date: string;
  logId: string;
}

type LogLike = Pick<IncoreWorkoutLogItem, 'SK' | 'date' | 'updatedAt' | 'exercises'>;

/** Newest log first: date, then updatedAt (two logs on one day → the later edit wins). */
export function compareLogsNewestFirst(a: LogLike, b: LogLike): number {
  return b.date.localeCompare(a.date) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
}

/** The newest sets for each exercise across a member's logs. Pure; exported for tests. */
export function computeLastByExercise(logs: LogLike[], onlyIds?: Set<string>): Map<string, LastWeight> {
  const out = new Map<string, LastWeight>();
  for (const log of [...logs].sort(compareLogsNewestFirst)) {
    for (const e of log.exercises ?? []) {
      if (out.has(e.exerciseId) || (onlyIds && !onlyIds.has(e.exerciseId))) continue;
      if (!e.sets || e.sets.length === 0) continue;
      out.set(e.exerciseId, {
        exerciseId: e.exerciseId,
        exerciseName: e.exerciseName,
        metrics: e.metrics,
        sets: e.sets,
        date: log.date,
        logId: log.SK.replace('WORKOUTLOG#', ''),
      });
    }
  }
  return out;
}

async function queryPrefix(uid: string, prefix: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${uid}`, ':prefix': prefix },
      ExclusiveStartKey: startKey,
    }));
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function batchWrite(requests: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: Record<string, unknown>[] | undefined = requests.slice(i, i + 25);
    for (let attempt = 0; pending && pending.length > 0 && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending as never } }));
      pending = res.UnprocessedItems?.[TABLE_NAME] as Record<string, unknown>[] | undefined;
      if (pending && pending.length > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
}

const pointerKey = (uid: string, exerciseId: string) => ({ PK: `MEMBER#${uid}`, SK: `${LAST_PREFIX}${exerciseId}` });

/**
 * Re-derives the pointers for `exerciseIds` (all exercises when omitted) from
 * the member's logs: writes the newest sets, deletes pointers for exercises
 * no longer in any log. A full rebuild also writes the BUILT marker.
 */
export async function refreshLastWeights(uid: string, exerciseIds?: string[]): Promise<Map<string, LastWeight>> {
  const only = exerciseIds ? new Set(exerciseIds) : undefined;
  if (only && only.size === 0) return new Map();
  const logs = (await queryPrefix(uid, 'WORKOUTLOG#')) as unknown as LogLike[];
  const latest = computeLastByExercise(logs, only);

  const stale = only
    ? [...only].filter((id) => !latest.has(id))
    : ((await queryPrefix(uid, LAST_PREFIX)) as { SK: string }[])
      .map((p) => p.SK.slice(LAST_PREFIX.length))
      .filter((id) => id !== '~built' && !latest.has(id));

  const nowIso = new Date().toISOString();
  await batchWrite([
    ...[...latest.values()].map((w) => ({ PutRequest: { Item: { ...pointerKey(uid, w.exerciseId), ...w, updatedAt: nowIso } } })),
    ...stale.map((id) => ({ DeleteRequest: { Key: pointerKey(uid, id) } })),
  ]);
  if (!only) {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { PK: `MEMBER#${uid}`, SK: BUILT_SK, builtAt: nowIso } }));
  }
  return latest;
}

function toLastWeight(item: Record<string, unknown>): LastWeight {
  return {
    exerciseId: String(item.exerciseId),
    exerciseName: String(item.exerciseName ?? ''),
    metrics: (item.metrics as IncoreExerciseMetric[]) ?? [],
    sets: (item.sets as Record<string, number>[]) ?? [],
    date: String(item.date ?? ''),
    logId: String(item.logId ?? ''),
  };
}

/** Pointers for a member: by exact key when ids are given, else the whole EXLAST# prefix. */
export async function readLastWeights(uid: string, exerciseIds?: string[]): Promise<LastWeight[]> {
  if (exerciseIds) {
    const keys = [{ PK: `MEMBER#${uid}`, SK: BUILT_SK }, ...exerciseIds.map((id) => pointerKey(uid, id))];
    const found: Record<string, unknown>[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE_NAME]: { Keys: keys.slice(i, i + 100) } } }));
      found.push(...((res.Responses?.[TABLE_NAME] ?? []) as Record<string, unknown>[]));
    }
    if (!found.some((f) => f.SK === BUILT_SK)) {
      const rebuilt = await refreshLastWeights(uid);
      return exerciseIds.map((id) => rebuilt.get(id)).filter((w): w is LastWeight => !!w);
    }
    return found.filter((f) => f.SK !== BUILT_SK).map(toLastWeight);
  }
  const items = await queryPrefix(uid, LAST_PREFIX);
  if (!items.some((f) => f.SK === BUILT_SK)) return [...(await refreshLastWeights(uid)).values()];
  return items.filter((f) => f.SK !== BUILT_SK).map(toLastWeight);
}

// GET /getWorkoutLastWeights?memberId=<uid>&exerciseIds=a,b,c
// Auth: Cognito JWT. Defaults to the caller's own data; another memberId
// needs admin or coach. Rides incoreWorkoutApi.ts's shared integration.
// Returns { lastWeights: LastWeight[] } newest first; an exercise the member
// never logged is simply absent.
export async function getWorkoutLastWeights(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const qs = event.queryStringParameters ?? {};
  const memberId = qs.memberId && qs.memberId !== callerUid ? qs.memberId : callerUid;
  if (memberId !== callerUid && !(await isCoachOrAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const ids = qs.exerciseIds
    ? [...new Set(qs.exerciseIds.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,100}$/.test(s)))].slice(0, MAX_IDS)
    : undefined;

  const lastWeights = (await readLastWeights(memberId, ids))
    .sort((a, b) => b.date.localeCompare(a.date) || a.exerciseName.localeCompare(b.exerciseName));
  return json(200, { lastWeights });
}
