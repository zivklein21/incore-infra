import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { json } from '../lib/http';
import { getCoachAccess } from '../lib/coachAccess';
import type { WorkoutPlanItem, WorkoutPlanBlockItem, ExerciseDefinitionItem, EquipmentItem } from '../lib/entities';

// GET or POST /adminListWorkoutPlans
// Auth: Cognito JWT, admin or a coach with workoutPlans:'read' or 'write' —
// same admin-sees-drafts-too / coach-sees-active-only split as
// adminListTestGroups.ts. Used by the admin builder
// (WorkoutPlansManageScreen.tsx), a coach's "assign a plan to this session"
// picker (assignSessionWorkoutPlan.ts is the write side), and the coach's
// read-only in-session plan view (WorkoutPlanDetailView.tsx) — this is the
// only place a plan's full section breakdown is ever fetched from, no
// separate "get one plan" endpoint exists (small-scale catalog, same
// "just list everything" precedent as fetchTemplate() client-side).
//
// One Scan over the WORKOUTPLAN# prefix returns METADATA and BLOCK# (=
// section) items together (same partition per plan — see entities.ts),
// assembled here into { workoutPlans: [{ ...plan, sections: [{ ...section,
// requiredEquipment: [...] }], requiredEquipment: [...] }] }. Each section's
// requiredEquipment sums its stations' exercises' own linked equipment
// quantities (see ExerciseEquipmentRequirement) plus a flat 1 per
// manualEquipmentIds entry (forced empty when noEquipmentNeeded), resolved
// to names — the plan-level requiredEquipment sums the same, across every
// section. Needs one extra small Scan (the Equipment catalog is documented
// ≤50 items) plus, for stations-mode sections, each referenced exercise's
// own equipment requirements (already scanned once here rather than N
// GetCommands).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = event.requestContext.authorizer.jwt.claims.sub as string;
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.workoutPlans === 'none') return json(403, { error: 'forbidden' });

  const [plansRes, exercisesRes, equipmentRes] = await Promise.all([
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'WORKOUTPLAN#' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'EXERCISE#', ':metadata': 'METADATA' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'EQUIPMENT#', ':metadata': 'METADATA' },
    })),
  ]);

  const equipmentNameById = new Map(
    ((equipmentRes.Items ?? []) as EquipmentItem[]).map((e) => [e.PK.replace('EQUIPMENT#', ''), e.name]),
  );
  const equipmentReqsByExerciseId = new Map(
    ((exercisesRes.Items ?? []) as ExerciseDefinitionItem[]).map((e) => [e.PK.replace('EXERCISE#', ''), e.equipment ?? []]),
  );

  const items = (plansRes.Items ?? []) as ((WorkoutPlanItem | WorkoutPlanBlockItem) & { PK: string; SK: string })[];

  const plansById = new Map<string, ReturnType<typeof toPlanShape>>();
  for (const item of items) {
    if (item.SK !== 'METADATA') continue;
    const plan = item as WorkoutPlanItem & { PK: string };
    plansById.set(plan.PK.replace('WORKOUTPLAN#', ''), toPlanShape(plan));
  }
  for (const item of items) {
    if (!item.SK.startsWith('BLOCK#')) continue;
    const section = item as WorkoutPlanBlockItem & { PK: string; SK: string };
    const planId = section.PK.replace('WORKOUTPLAN#', '');
    const plan = plansById.get(planId);
    if (plan) plan.sections.push(toSectionShape(section, equipmentReqsByExerciseId, equipmentNameById));
  }

  const workoutPlans = [...plansById.values()]
    .filter((p) => access.isAdmin || p.active)
    .map((p) => {
      const sections = p.sections.sort((a, b) => a.order - b.order);
      const quantityById = new Map<string, number>();
      for (const section of sections) for (const e of section.requiredEquipment) {
        quantityById.set(e.id, (quantityById.get(e.id) ?? 0) + e.quantity);
      }
      const requiredEquipment = [...quantityById.entries()]
        .map(([id, quantity]) => ({ id, name: equipmentNameById.get(id) ?? '', quantity }))
        .filter((e) => e.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ...p, sections, requiredEquipment };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return json(200, { workoutPlans });
}

function toPlanShape(p: WorkoutPlanItem & { PK: string }) {
  return {
    id: p.PK.replace('WORKOUTPLAN#', ''),
    name: p.name,
    active: p.active,
    workoutNumber: p.workoutNumber ?? '',
    workoutType: p.workoutType ?? '',
    package: p.package ?? '',
    workingMethod: p.workingMethod ?? '',
    workoutGoal: p.workoutGoal ?? '',
    timingStructure: p.timingStructure ?? '',
    category: p.category ?? null,
    sections: [] as ReturnType<typeof toSectionShape>[],
  };
}

function toSectionShape(
  b: WorkoutPlanBlockItem & { PK: string; SK: string },
  equipmentReqsByExerciseId: Map<string, { equipmentId: string; quantity: number }[]>,
  equipmentNameById: Map<string, string>,
) {
  const stations = (b.stations ?? []).slice().sort((a, c) => a.order - c.order);
  const noEquipmentNeeded = b.noEquipmentNeeded === true;

  // A manually-added item (not tied to any exercise) has no natural
  // quantity of its own — counted as 1, same as a plain "bring this"
  // checklist entry.
  const quantityById = new Map<string, number>(noEquipmentNeeded ? [] : (b.manualEquipmentIds ?? []).map((id) => [id, 1]));
  if (!noEquipmentNeeded) {
    for (const station of stations) for (const exId of station.exerciseIds) {
      for (const req of equipmentReqsByExerciseId.get(exId) ?? []) {
        quantityById.set(req.equipmentId, (quantityById.get(req.equipmentId) ?? 0) + req.quantity);
      }
    }
  }
  const requiredEquipment = [...quantityById.entries()]
    .map(([id, quantity]) => ({ id, name: equipmentNameById.get(id) ?? '', quantity }))
    .filter((e) => e.name)
    .sort((a, c) => a.name.localeCompare(c.name));

  return {
    id: b.SK.replace('BLOCK#', ''),
    planId: b.planId,
    label: b.label,
    order: b.order,
    timeMethod: b.timeMethod ?? '',
    mode: b.mode,
    stations,
    freeTextItems: b.freeTextItems ?? [],
    manualEquipmentIds: b.manualEquipmentIds ?? [],
    noEquipmentNeeded,
    coachGuidelines: b.coachGuidelines ?? '',
    locked: b.locked === true,
    measurable: b.measurable === true,
    requiredEquipment,
  };
}
