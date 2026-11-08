import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import { getUid, json } from '../http';
import { getCoachAccess, sessionInAccess, type CoachAccess } from '../coachAccess';
import { verifyFamilyLink } from '../familyLinks';
import { resolveStaffIdentity } from '../staffIdentity';
import { computeSessionEquipment, scanEquipmentCatalog, sessionOverrideSummary, type RequiredEquipmentEntry } from '../sessionDetail';
import { resolveWorkoutPlanEquipmentQuantities } from '../workoutPlanEquipment';
import { deletePlanCopy } from '../sessionInstance';
import { notifySessionUpdated, shouldNotifySessionUpdate } from '../sessionInfo/notifySession';
import { applySectionEdits, blockId, parseSectionEdits, stationText, type SectionEdit } from './sectionEdits';
import type { ClassItem, RegistrationItem, SessionEditLogEntry, TrainingTypeItem, WorkoutPlanBlockItem, WorkoutPlanItem } from '../entities';

const SESSION_EDIT_LOG_MAX = 50;
const EQUIPMENT_MAX_ITEMS = 60;
const EQUIPMENT_MAX_QUANTITY = 999;

type Result = APIGatewayProxyStructuredResultV2;
type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

const classKey = (classId: string) => ({ PK: `CLASS#${classId}`, SK: 'METADATA' });

async function getSession(classId: string): Promise<ClassItem | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: classKey(classId) }));
  return res.Item as ClassItem | undefined;
}

async function getPlanPartition(planId: string): Promise<{ plan?: WorkoutPlanItem; blocks: WorkoutPlanBlockItem[] }> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `WORKOUTPLAN#${planId}` },
  }));
  const items = (res.Items ?? []) as (WorkoutPlanItem | WorkoutPlanBlockItem)[];
  return {
    plan: items.find((i) => i.SK === 'METADATA') as WorkoutPlanItem | undefined,
    blocks: (items.filter((i) => i.SK.startsWith('BLOCK#')) as WorkoutPlanBlockItem[]).sort((a, b) => a.order - b.order),
  };
}

async function getTrainingType(session: ClassItem): Promise<TrainingTypeItem | undefined> {
  if (!session.trainingTypeId) return undefined;
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TRAININGTYPE#${session.trainingTypeId}`, SK: 'METADATA' } }));
  return res.Item as TrainingTypeItem | undefined;
}

async function rosterCount(classId: string): Promise<number> {
  const res = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
  }));
  return (res.Items ?? []).length;
}

/** planId: which plan's gear counts — undefined leaves plan gear out. */
async function sessionEquipment(session: ClassItem, classId: string, planId: string | undefined): Promise<RequiredEquipmentEntry[]> {
  const [trainingType, planQuantities, equipmentById, count] = await Promise.all([
    getTrainingType(session),
    planId ? resolveWorkoutPlanEquipmentQuantities(planId) : Promise.resolve(undefined),
    scanEquipmentCatalog(),
    rosterCount(classId),
  ]);
  return computeSessionEquipment(session, { trainingType, planQuantities, equipmentById, rosterCount: count });
}

function appendEditLog(session: ClassItem, entry: SessionEditLogEntry): SessionEditLogEntry[] {
  return [...(session.sessionEditLog ?? []), entry].slice(-SESSION_EDIT_LOG_MAX);
}

// ── GET /getSessionPlan ─────────────────────────────────────────────────────
// Query: { classId: string, childUid?: string }
// Auth: Cognito JWT — admin or the session's own coach (full plan, for the
// edit screen), a trainee registered to the session, or that trainee's
// linked parent (childUid). Rides incoreWorkoutApi.ts's shared integration.
//
// The session's EFFECTIVE plan and equipment: its override if it has one,
// otherwise the template. Trainees get a projection built field by field,
// never the stored section: coach guidelines and the plan's "dry info" stay
// staff-only.
export async function getSessionPlan(event: Event): Promise<Result> {
  const callerUid = getUid(event);
  const classId = event.queryStringParameters?.classId?.trim() ?? '';
  const childUid = event.queryStringParameters?.childUid?.trim() ?? '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const session = await getSession(classId);
  if (!session) return json(404, { error: 'session_not_found' });

  let staffAccess: CoachAccess | null = null;
  if (!childUid) {
    const access = await getCoachAccess(callerUid);
    if (access && sessionInAccess(access, session, callerUid)) staffAccess = access;
  }
  if (!staffAccess && !(await isSessionTrainee(callerUid, childUid, classId))) return json(403, { error: 'forbidden' });

  const canSeePlan = !staffAccess || staffAccess.permissions.workoutPlans !== 'none';
  const planId = canSeePlan ? session.workoutPlanId : undefined;
  const [{ blocks, plan }, equipment] = await Promise.all([
    planId ? getPlanPartition(planId) : Promise.resolve({ blocks: [] as WorkoutPlanBlockItem[], plan: undefined }),
    sessionEquipment(session, classId, planId),
  ]);

  const base = {
    classId,
    className: session.className ?? '',
    date: session.date,
    endDate: session.endDate ?? null,
    workoutPlanName: plan ? (session.workoutPlanName ?? plan.name) : null,
    editedForSession: !!session.planOverride || !!session.equipmentOverride,
    equipment: equipment.map((e) => ({ id: e.id, name: e.name, quantity: e.neededQuantity })),
  };

  if (staffAccess) {
    return json(200, {
      ...base,
      sections: plan ? blocks.map(toStaffSection) : null,
      equipmentTaken: (session.equipmentTaken ?? []).map((t) => t.equipmentId),
      override: sessionOverrideSummary(session),
      editLog: session.sessionEditLog ?? [],
      closedAt: session.closedAt ?? null,
    });
  }
  return json(200, {
    ...base,
    sections: plan ? blocks.map(toTraineeSection).filter((s) => s.stations.length > 0 || s.freeTextItems.length > 0) : null,
  });
}

async function isSessionTrainee(callerUid: string, childUid: string, classId: string): Promise<boolean> {
  let traineeUid = callerUid;
  if (childUid) {
    const link = await verifyFamilyLink(callerUid, childUid);
    if (!link.ok || link.table !== FORCA_TABLE_NAME) return false;
    traineeUid = childUid;
  }
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: `REG#${traineeUid}` } }));
  return !!(res.Item as RegistrationItem | undefined);
}

function toTraineeSection(b: WorkoutPlanBlockItem) {
  return {
    id: blockId(b),
    label: b.label,
    mode: b.mode,
    timeMethod: b.timeMethod ?? '',
    stations: [...(b.stations ?? [])].sort((x, y) => x.order - y.order).map((st) => ({
      id: st.id,
      name: st.name ?? '',
      text: stationText(st),
      notes: st.notes ?? '',
    })),
    freeTextItems: b.freeTextItems ?? [],
  };
}

function toStaffSection(b: WorkoutPlanBlockItem) {
  const section = toTraineeSection(b);
  const linkedIds = new Set((b.stations ?? []).filter((st) => st.exerciseIds.length > 0).map((st) => st.id));
  return {
    ...section,
    stations: section.stations.map((st) => ({ ...st, linked: linkedIds.has(st.id) })),
    locked: b.locked === true,
    coachGuidelines: b.coachGuidelines ?? '',
  };
}

// ── POST /saveSessionOverride ───────────────────────────────────────────────
// Body: { classId: string, sections?: SectionEdit[], equipment?: { equipmentId: string, quantity: number }[] }
// Auth: Cognito JWT — admin, or the session's own coach. Plan edits need any
// workoutPlans access (a coach's default is 'read': editing the copy for their
// own session never touches the library, which still needs 'write'); equipment needs
// equipment:'write'. A closed session is admin-only, as everywhere else.
//
// Saves this one session's plan and/or equipment as an override. A part left
// out, or sent back unchanged, isn't touched and creates no override. Plan
// edits land on the session's private copy, created on first save; the
// library plan and every other session are never written. Everything commits
// in one transaction, then at most one push goes out for the whole save.
export async function saveSessionOverride(event: Event): Promise<Result> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; sections?: unknown; equipment?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });
  if (body.sections === undefined && body.equipment === undefined) return json(400, { error: 'nothing_to_save' });

  const session = await getSession(classId);
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });
  if (session.closedAt && !access.isAdmin) return json(403, { error: 'session_closed' });
  if (body.sections !== undefined && access.permissions.workoutPlans === 'none') return json(403, { error: 'forbidden' });
  if (body.equipment !== undefined && !canEditEquipment(access, session)) return json(403, { error: 'forbidden' });

  let sectionEdits: SectionEdit[] | null = null;
  if (body.sections !== undefined) {
    const parsed = parseSectionEdits(body.sections);
    if (!parsed.ok) return json(400, { error: parsed.error });
    sectionEdits = parsed.sections;
  }

  const nowIso = new Date().toISOString();

  const equipmentResult = body.equipment === undefined ? null : await prepareEquipmentOverride(session, classId, body.equipment);
  if (equipmentResult && !equipmentResult.ok) return json(equipmentResult.status, { error: equipmentResult.error, ...equipmentResult.extra });
  const equipmentItems = equipmentResult?.ok ? equipmentResult.items : null;

  const planResult = sectionEdits ? await preparePlanOverride(session, classId, sectionEdits, callerUid, nowIso) : null;
  if (planResult && !planResult.ok) return json(planResult.status, { error: planResult.error });
  const planWrite = planResult?.ok ? planResult.write : null;

  if (!planWrite && !equipmentItems) return json(200, { success: true, changed: false, notified: 0 });

  const editor = await resolveStaffIdentity(callerUid, access);
  const parts: SessionEditLogEntry['parts'] = [...(planWrite ? ['plan' as const] : []), ...(equipmentItems ? ['equipment' as const] : [])];
  const sets = ['sessionEditLog = :log'];
  const values: Record<string, unknown> = {
    ':log': appendEditLog(session, { at: nowIso, by: editor, action: 'edit', parts }),
  };
  if (planWrite) {
    sets.push('workoutPlanId = :planId', 'planOverride = :planOverride');
    values[':planId'] = planWrite.planId;
    values[':planOverride'] = {
      basePlanId: planWrite.basePlanId, basePlanName: planWrite.basePlanName, editedAt: nowIso, editedBy: editor,
    } satisfies NonNullable<ClassItem['planOverride']>;
  }
  if (equipmentItems) {
    sets.push('equipmentOverride = :equipmentOverride');
    values[':equipmentOverride'] = { items: equipmentItems, editedAt: nowIso, editedBy: editor } satisfies NonNullable<ClassItem['equipmentOverride']>;
  }

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      ...(planWrite?.puts ?? []).map((Item) => ({ Put: { TableName: FORCA_TABLE_NAME, Item } })),
      {
        Update: {
          TableName: FORCA_TABLE_NAME,
          Key: classKey(classId),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeValues: values,
        },
      },
    ],
  }));

  const notified = shouldNotifySessionUpdate(session) ? await notifySessionUpdated(classId, session) : 0;
  return json(200, { success: true, changed: true, notified, parts });
}

// A coach who can't see plans sees a pack list with the plan's gear left out;
// saving that as the session's whole list would silently drop it for everyone.
function canEditEquipment(access: CoachAccess, session: ClassItem): boolean {
  if (access.permissions.equipment !== 'write') return false;
  return !session.workoutPlanId || access.permissions.workoutPlans !== 'none';
}

type Prepared<T> = ({ ok: true } & T) | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

async function prepareEquipmentOverride(
  session: ClassItem,
  classId: string,
  raw: unknown,
): Promise<Prepared<{ items: { equipmentId: string; quantity: number }[] | null }>> {
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'invalid_equipment' };
  if (raw.length > EQUIPMENT_MAX_ITEMS) return { ok: false, status: 400, error: 'too_many_equipment_items' };

  const seen = new Set<string>();
  const items: { equipmentId: string; quantity: number }[] = [];
  for (const entry of raw as unknown[]) {
    const e = (entry ?? {}) as { equipmentId?: unknown; quantity?: unknown };
    const equipmentId = typeof e.equipmentId === 'string' ? e.equipmentId.trim() : '';
    const quantity = typeof e.quantity === 'number' ? Math.floor(e.quantity) : NaN;
    if (!equipmentId || !(quantity >= 1 && quantity <= EQUIPMENT_MAX_QUANTITY)) return { ok: false, status: 400, error: 'invalid_equipment' };
    if (seen.has(equipmentId)) continue;
    seen.add(equipmentId);
    items.push({ equipmentId, quantity });
  }

  const current = await sessionEquipment(session, classId, session.workoutPlanId);
  const unchanged = current.length === items.length
    && current.every((c, i) => c.id === items[i].equipmentId && c.neededQuantity === items[i].quantity);
  if (unchanged) return { ok: true, items: null };

  const stillOut = stillTakenIds(session, new Set(items.map((i) => i.equipmentId)));
  if (stillOut.length > 0) return { ok: false, status: 409, error: 'equipment_still_taken', extra: { equipmentIds: stillOut } };
  return { ok: true, items };
}

// Checked-out gear has to stay on the list: returning it (and so closing the
// session) happens from that list.
function stillTakenIds(session: ClassItem, keptIds: Set<string>): string[] {
  return (session.equipmentTaken ?? []).map((t) => t.equipmentId).filter((id) => !keptIds.has(id));
}

async function preparePlanOverride(
  session: ClassItem,
  classId: string,
  edits: SectionEdit[],
  callerUid: string,
  nowIso: string,
): Promise<Prepared<{ write: { planId: string; basePlanId: string; basePlanName: string; puts: Record<string, unknown>[] } | null }>> {
  if (!session.workoutPlanId) return { ok: false, status: 400, error: 'no_workout_plan_assigned' };
  const { plan, blocks } = await getPlanPartition(session.workoutPlanId);
  if (!plan) return { ok: false, status: 404, error: 'workout_plan_not_found' };

  const applied = applySectionEdits(blocks, edits);
  if (!applied.ok) return { ok: false, status: 409, error: applied.error };
  if (applied.changed.length === 0) return { ok: true, write: null };

  const basePlanId = session.planOverride?.basePlanId ?? plan.sessionCopyOf ?? session.workoutPlanId;
  const basePlanName = session.planOverride?.basePlanName ?? session.workoutPlanName ?? plan.name;
  if (plan.sessionClassId === classId) {
    return { ok: true, write: { planId: session.workoutPlanId, basePlanId, basePlanName, puts: applied.changed as unknown as Record<string, unknown>[] } };
  }

  // First edit: the copy keeps the section ids, so what the screen loaded from
  // the template still matches, and keeps station ids, so logs still match.
  const copyId = randomUUID();
  const copyPk = `WORKOUTPLAN#${copyId}`;
  const puts: Record<string, unknown>[] = [
    { ...plan, PK: copyPk, active: true, sessionCopyOf: basePlanId, sessionClassId: classId, createdAt: nowIso, createdBy: callerUid },
    ...applied.blocks.map((b) => ({ ...b, PK: copyPk, planId: copyId, createdAt: nowIso })),
  ];
  return { ok: true, write: { planId: copyId, basePlanId, basePlanName, puts } };
}

// ── POST /resetSessionOverride ──────────────────────────────────────────────
// Body: { classId: string }
// Auth: same as saveSessionOverride, for the parts being reset.
//
// "Reset to original": drops the session's plan and equipment overrides and
// goes back to the template, deleting the private copy.
export async function resetSessionOverride(event: Event): Promise<Result> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });

  const session = await getSession(classId);
  if (!session) return json(404, { error: 'session_not_found' });
  if (!sessionInAccess(access, session, callerUid)) return json(403, { error: 'forbidden' });
  if (session.closedAt && !access.isAdmin) return json(403, { error: 'session_closed' });

  const { planOverride, equipmentOverride } = session;
  if (!planOverride && !equipmentOverride) return json(200, { success: true, changed: false, notified: 0 });
  if (planOverride && access.permissions.workoutPlans === 'none') return json(403, { error: 'forbidden' });
  if (equipmentOverride && !canEditEquipment(access, session)) return json(403, { error: 'forbidden' });

  let basePlan: WorkoutPlanItem | undefined;
  if (planOverride) {
    basePlan = (await getPlanPartition(planOverride.basePlanId)).plan;
    // The edited version is all that's left of this session's plan: keep it.
    if (!basePlan) return json(409, { error: 'base_plan_missing' });
  }

  const restoredList = await sessionEquipment(
    { ...session, equipmentOverride: undefined },
    classId,
    planOverride?.basePlanId ?? session.workoutPlanId,
  );
  const stillOut = stillTakenIds(session, new Set(restoredList.map((e) => e.id)));
  if (stillOut.length > 0) return json(409, { error: 'equipment_still_taken', equipmentIds: stillOut });

  const editor = await resolveStaffIdentity(callerUid, access);
  const parts: SessionEditLogEntry['parts'] = [...(planOverride ? ['plan' as const] : []), ...(equipmentOverride ? ['equipment' as const] : [])];
  const sets = ['sessionEditLog = :log'];
  const removes = ['equipmentOverride', 'planOverride'];
  const values: Record<string, unknown> = {
    ':log': appendEditLog(session, { at: new Date().toISOString(), by: editor, action: 'reset', parts }),
  };
  if (planOverride && basePlan) {
    sets.push('workoutPlanId = :planId', 'workoutPlanName = :planName');
    values[':planId'] = planOverride.basePlanId;
    values[':planName'] = basePlan.name;
    // The base may not be the plan the copy came from any more (the recurring
    // template moved on), so re-resolve like assignSessionWorkoutPlan.ts does.
    const trainingType = await getTrainingType(session);
    if (trainingType?.category === 'running' || basePlan.category === 'running') {
      sets.push('isRunningSession = :isRunning');
      values[':isRunning'] = true;
    } else {
      removes.push('isRunningSession');
    }
  }

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: classKey(classId),
    UpdateExpression: `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`,
    ExpressionAttributeValues: values,
  }));
  if (planOverride && session.workoutPlanId) await deletePlanCopy(session.workoutPlanId);

  const notified = shouldNotifySessionUpdate(session) ? await notifySessionUpdated(classId, session) : 0;
  return json(200, { success: true, changed: true, notified, parts });
}
