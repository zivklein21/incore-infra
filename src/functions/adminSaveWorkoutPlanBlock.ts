import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { ExerciseDefinitionItem, WorkoutPlanBlockItem, WorkoutPlanSectionMode, WorkoutPlanStation } from '../lib/entities';

interface StationInput { id?: unknown; name?: unknown; exerciseIds?: unknown; notes?: unknown }

async function resolveStations(raw: unknown): Promise<WorkoutPlanStation[]> {
  if (!Array.isArray(raw)) return [];
  const inputs = (raw as StationInput[])
    .filter((s): s is StationInput => !!s && typeof s === 'object' && Array.isArray(s.exerciseIds))
    .map((s) => ({
      ...s,
      exerciseIds: [...new Set((s.exerciseIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()))],
    }))
    .filter((s) => s.exerciseIds.length > 0);
  const allExerciseIds = [...new Set(inputs.flatMap((s) => s.exerciseIds))];
  const exercisesById = new Map<string, ExerciseDefinitionItem>();
  await Promise.all(allExerciseIds.map(async (exId) => {
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${exId}`, SK: 'METADATA' } }));
    if (res.Item) exercisesById.set(exId, res.Item as ExerciseDefinitionItem);
  }));

  const stations: WorkoutPlanStation[] = [];
  let order = 0;
  for (const input of inputs) {
    // Alternatives whose exercise no longer exists in the catalog are
    // dropped rather than failing the whole section save — same tolerant
    // convention as equipmentIds elsewhere. A station left with zero
    // resolved exercises is dropped entirely.
    const resolved = input.exerciseIds.filter((id) => exercisesById.has(id));
    if (resolved.length === 0) continue;
    stations.push({
      id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
      order,
      exerciseIds: resolved,
      exerciseNames: resolved.map((id) => exercisesById.get(id)!.name),
      ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
      ...(typeof input.notes === 'string' && input.notes.trim() ? { notes: input.notes.trim() } : {}),
    });
    order += 1;
  }
  return stations;
}

// POST /adminSaveWorkoutPlanBlock
// Body: { id?: string, planId: string, label: string, timeMethod?: string,
//         mode?: 'stations' | 'sequentialRoute' | 'freeText',
//         stations?: { id?: string, name?: string, exerciseIds: string[], notes?: string }[],
//         freeTextItems?: string[], manualEquipmentIds?: string[],
//         noEquipmentNeeded?: boolean, coachGuidelines?: string, order?: number,
//         measurable?: boolean }
//   — omit id to create; omit order on create to append at the end of the
//   plan's section list
// Auth: Cognito JWT, admin or a coach with workoutPlans:'write'.
// `locked` is never accepted from the client — it's set exactly once, by
// adminSaveWorkoutPlan.ts, for the one auto-created closing section, and
// preserved as-is on every update here (a coach may edit a locked section's
// text but can't unlock/relock one by resending it — see
// adminDeleteWorkoutPlanBlock.ts for the actual deletion guard). Each
// station's exerciseIds (one or more interchangeable alternatives, e.g.
// "Squat / Lunge") are resolved against the Exercise catalog here (to
// denormalize their names) — an alternative whose exercise no longer exists
// is silently dropped; a station left with none is dropped entirely, rather
// than failing the whole save.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans !== 'write') return json(403, { error: 'forbidden' });

  let body: {
    id?: unknown; planId?: unknown; label?: unknown; timeMethod?: unknown; mode?: unknown;
    stations?: unknown; freeTextItems?: unknown; manualEquipmentIds?: unknown;
    noEquipmentNeeded?: unknown; coachGuidelines?: unknown; order?: unknown; measurable?: unknown;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
  if (!planId) return json(400, { error: 'missing_plan_id' });
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) return json(400, { error: 'missing_label' });
  const timeMethod = typeof body.timeMethod === 'string' && body.timeMethod.trim() ? body.timeMethod.trim() : undefined;
  const mode: WorkoutPlanSectionMode =
    body.mode === 'stations' ? 'stations' : body.mode === 'sequentialRoute' ? 'sequentialRoute' : 'freeText';
  // 'stations' and 'sequentialRoute' share the exact same ordered-step shape
  // (WorkoutPlanStation) — 'sequentialRoute' is purely a labeling/rendering
  // distinction (a cone-route path vs. numbered stations), not a different
  // data model.
  const usesStations = mode === 'stations' || mode === 'sequentialRoute';
  const freeTextItems = Array.isArray(body.freeTextItems)
    ? body.freeTextItems.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
    : undefined;
  const manualEquipmentIds = Array.isArray(body.manualEquipmentIds)
    ? body.manualEquipmentIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : undefined;
  const noEquipmentNeeded = body.noEquipmentNeeded === true;
  const coachGuidelines = typeof body.coachGuidelines === 'string' && body.coachGuidelines.trim() ? body.coachGuidelines.trim() : undefined;
  // Only meaningful for a 'stations' section — a 'freeText' or
  // 'sequentialRoute' section has nothing a trainee logs post-session
  // results against, so the flag is dropped for it regardless of what the
  // client sends.
  const measurable = mode === 'stations' && body.measurable === true;
  const stations = usesStations ? await resolveStations(body.stations) : [];

  const planRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${planId}`, SK: 'METADATA' } }));
  if (!planRes.Item) return json(404, { error: 'workout_plan_not_found' });

  const existingId = typeof body.id === 'string' && body.id ? body.id : null;
  const id = existingId ?? randomUUID();

  let createdAt = new Date().toISOString();
  let locked: true | undefined;
  let order = typeof body.order === 'number' && Number.isFinite(body.order) ? body.order : null;

  if (existingId) {
    const existingRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `WORKOUTPLAN#${planId}`, SK: `BLOCK#${existingId}` } }));
    const existing = existingRes.Item as WorkoutPlanBlockItem | undefined;
    if (existing) {
      createdAt = existing.createdAt;
      if (existing.locked) locked = true;
      if (order === null) order = existing.order;
    }
  }

  if (order === null) {
    const currentRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${planId}`, ':prefix': 'BLOCK#' },
    }));
    order = (currentRes.Items ?? []).length;
  }

  const item: WorkoutPlanBlockItem = {
    PK: `WORKOUTPLAN#${planId}`,
    SK: `BLOCK#${id}`,
    planId,
    label,
    order,
    mode,
    ...(timeMethod ? { timeMethod } : {}),
    ...(usesStations && stations.length > 0 ? { stations } : {}),
    ...(mode === 'freeText' && freeTextItems && freeTextItems.length > 0 ? { freeTextItems } : {}),
    ...(manualEquipmentIds && manualEquipmentIds.length > 0 ? { manualEquipmentIds } : {}),
    ...(noEquipmentNeeded ? { noEquipmentNeeded } : {}),
    ...(coachGuidelines ? { coachGuidelines } : {}),
    ...(locked ? { locked } : {}),
    ...(measurable ? { measurable } : {}),
    createdAt,
  };

  await ddb.send(new PutCommand({ TableName: FORCA_TABLE_NAME, Item: item }));

  return json(200, { success: true, id });
}
