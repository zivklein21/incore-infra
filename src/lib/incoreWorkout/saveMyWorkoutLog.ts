import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { BatchGetCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import {
  israelDateStr,
  type ClassItem,
  type IncoreExerciseItem,
  type IncoreWorkoutLogExercise,
  type IncoreWorkoutLogItem,
  type RegistrationItem,
} from '../entities';
import { cleanSets, exerciseKey, muscleGroupsOf, toWorkoutLogDto } from '../incoreExercises';

const MAX_EXERCISES = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST /saveMyWorkoutLog
// Body: { id?: string, classId?: string, date?: 'YYYY-MM-DD', title?: string,
//         exercises: { exerciseId: string, sets: Record<metricKey, number>[] }[],
//         importedFrom?: string }
// Auth: Cognito JWT, any signed-in INCORE member — always writes to the
// caller's own journal (PK=MEMBER#<caller>).
//
// Three ways a log gets its id (see entities.ts's IncoreWorkoutLogItem):
//   classId      → `cls_<classId>`; the caller must hold a REGISTERED booking
//                  for a class that has already started. date/className
//                  come from the class, not the body.
//   importedFrom → `imp_<sanitized>`; the one-time on-device history import
//                  (incore-app's useWorkoutJournal.ts). Deterministic, so a
//                  retried import is a no-op instead of a duplicate.
//   otherwise    → body.id when editing an existing free log, else a new uuid.
//
// Each exercise's name/muscle group/metrics are snapshotted from the catalog.
// An exercise since removed from the catalog is still accepted when editing
// a log that already contains it (its old snapshot is kept), so deleting a
// catalog entry never makes an old workout un-editable.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' && body.classId ? body.classId : null;
  const importedFrom = typeof body.importedFrom === 'string' && body.importedFrom
    ? body.importedFrom.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) : null;
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 60) : undefined;

  let id: string;
  let date: string;
  let className: string | undefined;

  if (classId) {
    const [regRes, classRes] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: `REG#${callerUid}` } })),
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
    ]);
    const reg = regRes.Item as RegistrationItem | undefined;
    const cls = classRes.Item as ClassItem | undefined;
    if (!reg || reg.status !== 'REGISTERED' || !cls) return json(403, { error: 'not_booked' });
    const classDate = new Date(cls.date);
    if (classDate.getTime() > Date.now()) return json(400, { error: 'class_not_started' });
    id = `cls_${classId}`;
    date = israelDateStr(classDate);
    className = cls.className;
  } else {
    date = typeof body.date === 'string' && DATE_RE.test(body.date) ? body.date : '';
    if (!date) return json(400, { error: 'invalid_date' });
    if (date > israelDateStr(new Date())) return json(400, { error: 'future_date' });
    if (importedFrom) id = `imp_${importedFrom}`;
    else if (typeof body.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(body.id) && !body.id.startsWith('cls_')) id = body.id;
    else id = randomUUID();
  }

  const logKey = { PK: `MEMBER#${callerUid}`, SK: `WORKOUTLOG#${id}` };
  const existing = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: logKey }))).Item as IncoreWorkoutLogItem | undefined;
  // A re-run import (second device, retry after a dropped response) must
  // never clobber edits made since the first import — first write wins.
  if (importedFrom && existing) return json(200, { success: true, log: toWorkoutLogDto(existing) });

  const rawExercises = Array.isArray(body.exercises) ? (body.exercises as Record<string, unknown>[]).slice(0, MAX_EXERCISES) : [];
  const exerciseIds = [...new Set(rawExercises.map((e) => (typeof e?.exerciseId === 'string' ? e.exerciseId : '')).filter(Boolean))];
  if (exerciseIds.length === 0) return json(400, { error: 'missing_exercises' });

  const catalogRes = await ddb.send(new BatchGetCommand({
    RequestItems: { [TABLE_NAME]: { Keys: exerciseIds.map(exerciseKey) } },
  }));
  const catalogById = new Map(
    ((catalogRes.Responses?.[TABLE_NAME] ?? []) as IncoreExerciseItem[]).map((e) => [e.SK.replace('EX#', ''), e]),
  );
  const previousById = new Map((existing?.exercises ?? []).map((e) => [e.exerciseId, e]));

  const exercises: IncoreWorkoutLogExercise[] = [];
  for (const raw of rawExercises) {
    const exerciseId = typeof raw?.exerciseId === 'string' ? raw.exerciseId : '';
    const catalog = catalogById.get(exerciseId);
    const snapshot = catalog
      ? { exerciseName: catalog.name, muscleGroup: catalog.muscleGroup, muscleGroups: muscleGroupsOf(catalog), metrics: catalog.metrics }
      : previousById.get(exerciseId);
    if (!snapshot) return json(404, { error: 'exercise_not_found', exerciseId });
    const sets = cleanSets(raw.sets, snapshot.metrics);
    if (sets.length === 0) continue; // an exercise with nothing filled in isn't a log
    exercises.push({
      exerciseId,
      exerciseName: snapshot.exerciseName,
      muscleGroup: snapshot.muscleGroup,
      muscleGroups: muscleGroupsOf(snapshot),
      metrics: snapshot.metrics,
      sets,
    });
  }
  if (exercises.length === 0) return json(400, { error: 'missing_values' });

  const nowIso = new Date().toISOString();
  const item: IncoreWorkoutLogItem = {
    ...logKey,
    userId: callerUid,
    date,
    ...(title ? { title } : {}),
    ...(classId ? { classId } : {}),
    ...(className ? { className } : {}),
    exercises,
    ...(importedFrom ?? existing?.importedFrom ? { importedFrom: importedFrom ?? existing?.importedFrom } : {}),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return json(200, { success: true, log: toWorkoutLogDto(item) });
}
