import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { isAdmin } from '../auth';
import type { IncoreExerciseItem } from '../entities';
import { exerciseKey, queryCatalog } from '../incoreExercises';
import { PRESET_METRICS, STARTER_EXERCISES } from '../incoreStarterExercises';

// POST /adminSeedIncoreExercises
// Auth: Cognito JWT, admin only. Imports the starter library (the ~80
// exercises incore-app used to bundle) into the INCORE catalog, skipping
// every id that already exists — safe to press twice, and never overwrites
// an exercise the admin has since edited. (A starter exercise the admin
// deleted IS re-created by pressing it again; hide it with active: false
// instead if it should stay gone.)
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const existingIds = new Set((await queryCatalog(ddb, TABLE_NAME)).map((e) => e.SK.replace('EX#', '')));
  const nowIso = new Date().toISOString();

  const toWrite: IncoreExerciseItem[] = STARTER_EXERCISES
    .filter(([id]) => !existingIds.has(id))
    .map(([id, name, nameEn, muscleGroup, preset]) => ({
      ...exerciseKey(id),
      name,
      nameEn,
      muscleGroup,
      metrics: PRESET_METRICS[preset],
      active: true,
      createdAt: nowIso,
      createdBy: callerUid,
      updatedAt: nowIso,
    }));

  for (let i = 0; i < toWrite.length; i += 25) {
    let pending: Record<string, unknown>[] | undefined = toWrite.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    // BatchWrite can hand back UnprocessedItems under throttling — retry
    // those a few times rather than silently dropping part of the library.
    for (let attempt = 0; pending && pending.length > 0 && attempt < 5; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending as never } }));
      pending = res.UnprocessedItems?.[TABLE_NAME] as Record<string, unknown>[] | undefined;
      if (pending && pending.length > 0) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  return json(200, { success: true, added: toWrite.length, skipped: STARTER_EXERCISES.length - toWrite.length });
}
