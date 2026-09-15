import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { ExerciseDefinitionItem, WorkoutPlanBlockItem } from './entities';

// Resolves how much of each equipment item a Workout Plan's stations-mode
// sections need in total — same aggregation rule as
// adminListWorkoutPlans.ts's toSectionShape/plan-level sums: each station's
// exercises' own ExerciseEquipmentRequirement quantities, summed, plus a
// flat 1 per section's manualEquipmentIds entry, skipped entirely for a
// section flagged noEquipmentNeeded. Deliberately a separate, single-plan
// lookup rather than reusing adminListWorkoutPlans.ts's batch computation
// (which pre-scans every exercise/equipment item to serve the whole plans
// list at once) — used to extend a session's checkout-tracked equipment
// pack list (see lib/sessionDetail.ts, toggleSessionEquipment.ts) to also
// cover gear the assigned plan itself calls for, on top of whatever its
// Training Type already lists.
export async function resolveWorkoutPlanEquipmentQuantities(planId: string): Promise<Map<string, number>> {
  const blocksRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${planId}`, ':prefix': 'BLOCK#' },
  }));
  const blocks = (blocksRes.Items ?? []) as WorkoutPlanBlockItem[];

  const exerciseIds = new Set<string>();
  for (const b of blocks) {
    if (b.noEquipmentNeeded) continue;
    for (const st of b.stations ?? []) for (const exId of st.exerciseIds) exerciseIds.add(exId);
  }
  const exercisesById = new Map<string, ExerciseDefinitionItem>();
  await Promise.all([...exerciseIds].map(async (exId) => {
    const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `EXERCISE#${exId}`, SK: 'METADATA' } }));
    if (res.Item) exercisesById.set(exId, res.Item as ExerciseDefinitionItem);
  }));

  const quantityById = new Map<string, number>();
  for (const b of blocks) {
    if (b.noEquipmentNeeded) continue;
    for (const id of b.manualEquipmentIds ?? []) quantityById.set(id, (quantityById.get(id) ?? 0) + 1);
    for (const st of b.stations ?? []) for (const exId of st.exerciseIds) {
      for (const req of exercisesById.get(exId)?.equipment ?? []) {
        quantityById.set(req.equipmentId, (quantityById.get(req.equipmentId) ?? 0) + req.quantity);
      }
    }
  }
  return quantityById;
}

// Batch variant for endpoints resolving many sessions at once (see
// fetchSessionLookups in lib/sessionDetail.ts) — resolves each unique plan
// id in parallel rather than serially, since several sessions commonly
// share the same assigned plan.
export async function resolveWorkoutPlanEquipmentQuantitiesBatch(planIds: string[]): Promise<Map<string, Map<string, number>>> {
  const uniqueIds = [...new Set(planIds)];
  const results = await Promise.all(uniqueIds.map((id) => resolveWorkoutPlanEquipmentQuantities(id)));
  return new Map(uniqueIds.map((id, i) => [id, results[i]]));
}
