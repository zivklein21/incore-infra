// Shared "resolve a training session's full detail (roster + equipment pack
// list)" logic — extracted out of getCoachSessions.ts so getTrainingHistory.ts
// can reuse the exact same computation instead of duplicating it. See
// getCoachSessions.ts for the full behavioral write-up.

import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { CoachAccess } from './coachAccess';
import { activeMedicalAlert } from './medicalAlert';
import { resolveWorkoutPlanEquipmentQuantitiesBatch } from './workoutPlanEquipment';
import { getAllMemberProfiles } from './memberScan';
import {
  deriveMemberName,
  type ClassItem,
  type EquipmentItem,
  type GroupItem,
  type MemberProfileItem,
  type RegistrationItem,
  type TrainingTypeItem,
} from './entities';

export interface EquipmentCatalogEntry { name: string; availableQuantity: number }

export interface RequiredEquipmentEntry { id: string; name: string; neededQuantity: number; availableQuantity: number }

export interface SessionOverrideSummary { plan: boolean; equipment: boolean; editedAt: string; editedByName: string }

export interface SessionLookups {
  trainingTypesById: Map<string, TrainingTypeItem>;
  groupNameById: Map<string, string>;
  equipmentById: Map<string, EquipmentCatalogEntry>;
  /** Each referenced Workout Plan's own required equipment quantities — see resolveWorkoutPlanEquipmentQuantities(). */
  planEquipmentByPlanId: Map<string, Map<string, number>>;
  /** Every FORCA member's profile, keyed by uid — see fetchSessionLookups()'s comment on why this is one Scan, not a GetCommand per roster entry. */
  profileById: Map<string, MemberProfileItem>;
}

/**
 * Fetches the shared Training Type / Group / Equipment / Member-Profile
 * lookup tables needed to resolve any set of sessions — equipment is only
 * scanned when at least one of the given sessions actually references a
 * training type with equipment requirements, since most callers' session
 * sets are untyped. Profiles are scanned unconditionally (one Scan of
 * ≤50 FORCA members, same accepted tradeoff getAllMemberProfiles() already
 * documents) and shared by every session's roster resolution below —
 * previously each session did its own GetCommand per registered member,
 * which duplicated work for any trainee appearing in more than one session
 * and was a real contributor to getCoachSessions.ts's timeout on top of the
 * Scan-vs-Query fix there.
 */
export async function fetchSessionLookups(sessionItems: ClassItem[]): Promise<SessionLookups> {
  const [trainingTypesRes, groupsRes, profiles] = await Promise.all([
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'TRAININGTYPE#', ':metadata': 'METADATA' },
    })),
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'GROUP#', ':metadata': 'METADATA' },
    })),
    getAllMemberProfiles(FORCA_TABLE_NAME),
  ]);
  const trainingTypesById = new Map(
    ((trainingTypesRes.Items ?? []) as TrainingTypeItem[]).map((t) => [t.PK.replace('TRAININGTYPE#', ''), t]),
  );
  const groupNameById = new Map(
    ((groupsRes.Items ?? []) as GroupItem[]).map((g) => [g.PK.replace('GROUP#', ''), g.name ?? '']),
  );
  const profileById = new Map(profiles.map((p) => [p.PK.replace('MEMBER#', ''), p]));

  const planIdsNeeded = [...new Set(sessionItems.map((s) => s.workoutPlanId).filter((id): id is string => !!id))];
  const planEquipmentByPlanId = await resolveWorkoutPlanEquipmentQuantitiesBatch(planIdsNeeded);

  const equipmentIdsNeeded = new Set<string>();
  for (const session of sessionItems) {
    const tt = session.trainingTypeId ? trainingTypesById.get(session.trainingTypeId) : undefined;
    (tt?.equipmentRequirements ?? []).forEach((r) => equipmentIdsNeeded.add(r.equipmentId));
  }
  for (const quantities of planEquipmentByPlanId.values()) for (const id of quantities.keys()) equipmentIdsNeeded.add(id);
  for (const session of sessionItems) (session.manualEquipment ?? []).forEach((m) => equipmentIdsNeeded.add(m.equipmentId));
  for (const session of sessionItems) (session.equipmentOverride?.items ?? []).forEach((m) => equipmentIdsNeeded.add(m.equipmentId));
  const equipmentById = equipmentIdsNeeded.size > 0 ? await scanEquipmentCatalog() : new Map<string, EquipmentCatalogEntry>();

  return { trainingTypesById, groupNameById, equipmentById, planEquipmentByPlanId, profileById };
}

export async function scanEquipmentCatalog(): Promise<Map<string, EquipmentCatalogEntry>> {
  const equipmentById = new Map<string, EquipmentCatalogEntry>();
  // Paginated — a Scan reads at most 1MB per page BEFORE the filter is
  // applied, so a single page silently misses equipment on a big table.
  let lastKey: Record<string, unknown> | undefined;
  do {
    const equipmentRes = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'EQUIPMENT#', ':metadata': 'METADATA' },
      ExclusiveStartKey: lastKey,
    }));
    for (const e of (equipmentRes.Items ?? []) as EquipmentItem[]) {
      equipmentById.set(e.PK.replace('EQUIPMENT#', ''), {
        name: e.name ?? '',
        availableQuantity: (e.quantity ?? 0) - (e.outCount ?? 0),
      });
    }
    lastKey = equipmentRes.LastEvaluatedKey;
  } while (lastKey);
  return equipmentById;
}

export interface SessionEquipmentInputs {
  trainingType: TrainingTypeItem | undefined;
  /** The session's plan's own quantities — undefined leaves plan gear out (a coach with no workoutPlans access). */
  planQuantities: Map<string, number> | undefined;
  equipmentById: Map<string, EquipmentCatalogEntry>;
  rosterCount: number;
}

/**
 * A session's effective pack list, in display order. equipmentOverride is the
 * whole answer when present; otherwise Training Type + Workout Plan with the
 * session's manualEquipment on top. The one place this is computed, so the
 * coach's checklist, "took everything", and the trainee view can't disagree.
 */
export function computeSessionEquipment(
  session: Pick<ClassItem, 'manualEquipment' | 'equipmentOverride'>,
  { trainingType, planQuantities, equipmentById, rosterCount }: SessionEquipmentInputs,
): RequiredEquipmentEntry[] {
  // An equipmentId with no EQUIPMENT# item (deleted from the catalog but
  // still referenced by a Training Type / Workout Plan / override) is
  // skipped everywhere below — otherwise it renders as a nameless
  // "Missing — only 0 available" row that can never be satisfied.
  const entry = (id: string, neededQuantity: number): RequiredEquipmentEntry | null => {
    const equipment = equipmentById.get(id);
    return equipment ? { id, name: equipment.name, neededQuantity, availableQuantity: equipment.availableQuantity } : null;
  };

  if (session.equipmentOverride) {
    return session.equipmentOverride.items
      .map((i) => entry(i.equipmentId, i.quantity))
      .filter((e): e is RequiredEquipmentEntry => !!e);
  }

  const requiredEquipment: RequiredEquipmentEntry[] = [];
  for (const r of trainingType?.equipmentRequirements ?? []) {
    const item = entry(r.equipmentId, r.mode === 'custom' ? (r.customQuantity ?? 0) : rosterCount);
    if (item) requiredEquipment.push(item);
  }

  // The assigned Workout Plan's own required equipment, on top of whatever
  // the Training Type already lists — same checkout-tracked pack list, not
  // a separate one (see toggleSessionEquipment.ts). Quantity is the sum of
  // each exercise's own ExerciseEquipmentRequirement across the plan's
  // stations (see resolveWorkoutPlanEquipmentQuantities()) — there's no
  // custom/per_member "mode" for a plan-derived item the way a Training
  // Type requirement has, so this is the closest real equivalent. Never
  // duplicated for an equipmentId the Training Type already covers.
  const existingIds = new Set(requiredEquipment.map((e) => e.id));
  for (const [equipmentId, neededQuantity] of planQuantities ?? []) {
    if (existingIds.has(equipmentId)) continue;
    const item = entry(equipmentId, neededQuantity);
    if (item) requiredEquipment.push(item);
  }

  // This session's own per-equipment-id overrides (see
  // adminUpdateSessionInstance.ts) — an id the Training Type/Workout Plan
  // already imply has its neededQuantity REPLACED by the override (every
  // other implied item keeps its normal computed quantity); an id neither
  // implies is pushed as a new extra item at the override's quantity, same
  // "extra add, on top" idea as a Workout Plan section's own
  // manualEquipmentIds.
  const requiredById = new Map(requiredEquipment.map((e) => [e.id, e]));
  for (const { equipmentId, quantity } of session.manualEquipment ?? []) {
    const existing = requiredById.get(equipmentId);
    if (existing) {
      existing.neededQuantity = quantity;
      continue;
    }
    const added = entry(equipmentId, quantity);
    if (added) {
      requiredEquipment.push(added);
      requiredById.set(equipmentId, added);
    }
  }
  return requiredEquipment;
}

/** What a coach-facing session read says about this session's overrides. Null when it has none. */
export function sessionOverrideSummary(session: Pick<ClassItem, 'planOverride' | 'equipmentOverride'>): SessionOverrideSummary | null {
  const { planOverride, equipmentOverride } = session;
  if (!planOverride && !equipmentOverride) return null;
  const latest = [planOverride, equipmentOverride]
    .filter((o): o is NonNullable<typeof o> => !!o)
    .sort((a, b) => b.editedAt.localeCompare(a.editedAt))[0];
  return { plan: !!planOverride, equipment: !!equipmentOverride, editedAt: latest.editedAt, editedByName: latest.editedBy.name };
}

export interface RosterEntryDetail {
  memberId: string;
  name: string;
  declaredAttendance: 'pending' | 'yes' | 'no';
  declineReason: string | null;
  actualAttendance: 'present' | 'absent' | null;
  /** Who last recorded/corrected actualAttendance — see RegistrationItem.actualAttendanceBy. Null on any entry predating this field, or with no actualAttendance recorded yet. */
  actualAttendanceBy: { uid: string; name: string; role: 'admin' | 'coach' } | null;
  /** Derived from health declaration answers, so admin-only: always false for a coach. */
  medicalFlag: boolean;
  /** The admin-written alert text while it's on — the only medical data a coach gets (lib/medicalAlert.ts). */
  medicalAlert: string | null;
}

export interface SessionDetail {
  classId: string;
  date: string;
  /** Scheduled end instant, denormalized from the recurring template's own
   * endTime at materialization — see ClassItem.endDate's own comment. Only
   * set when that template had an endTime configured. */
  endDate: string | null;
  className: string;
  groupId: string;
  groupName: string;
  location: string | null;
  coachId: string | null;
  coachName: string | null;
  requiredEquipment: RequiredEquipmentEntry[];
  /** Set when this session has been edited on its own (plan and/or equipment) — drives the "edited for this session" badge. */
  sessionOverride: SessionOverrideSummary | null;
  /** This session's own equipment overrides (see adminUpdateSessionInstance.ts) — distinct from requiredEquipment, which is the full computed pack list (Training Type + Workout Plan + these applied on top). Only ever populated for an admin edit-session-instance sheet; not itself a checklist. */
  manualEquipment: { equipmentId: string; quantity: number }[];
  equipmentTaken: string[];
  equipmentReturnedAt: string | null;
  closedAt: string | null;
  workoutPlanId: string | null;
  workoutPlanName: string | null;
  isTestSession: boolean;
  testGroupId: string | null;
  testGroupName: string | null;
  testComponentIds: string[] | null;
  isRunningSession: boolean;
  /** Trainee-facing note + "what to bring" list — see ClassItem.traineeNote. */
  traineeNote: string | null;
  traineeEquipment: string[];
  /** Links this instance back to its RecurringSessionItem template (see
   * lib/sessionInstance.ts's createSessionInstance()) — null for a one-off
   * session created without a template. Lets the admin edit/delete sheets
   * offer a "this and all future occurrences" scope, not just this one
   * instance — see adminUpdateSessionInstanceSeries.ts/
   * adminCancelSessionInstanceSeries.ts. */
  recurringSessionId: string | null;
  roster: RosterEntryDetail[];
}

export async function resolveSessionDetail(
  session: ClassItem & { PK: string },
  lookups: SessionLookups,
  access: CoachAccess,
): Promise<SessionDetail> {
  const classId = session.PK.replace('CLASS#', '');
  const regsRes = await ddb.send(new QueryCommand({
    TableName: FORCA_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CLASS#${classId}`, ':prefix': 'REG#' },
  }));
  const registrations = (regsRes.Items ?? []) as RegistrationItem[];

  const roster: RosterEntryDetail[] = registrations.map((r) => {
    const profile = lookups.profileById.get(r.userId);
    const healthAnswers = profile?.forms?.health_declaration?.answers ?? {};
    return {
      memberId: r.userId,
      name: profile ? deriveMemberName(profile) : r.userId,
      declaredAttendance: r.declaredAttendance ?? 'pending',
      declineReason: r.declineReason || null,
      actualAttendance: r.actualAttendance ?? null,
      actualAttendanceBy: r.actualAttendanceBy ?? null,
      medicalFlag: access.isAdmin && Object.values(healthAnswers).some((v) => v === 'yes'),
      medicalAlert: activeMedicalAlert(profile),
    };
  });
  roster.sort((a, b) => a.name.localeCompare(b.name));

  const requiredEquipment = computeSessionEquipment(session, {
    trainingType: session.trainingTypeId ? lookups.trainingTypesById.get(session.trainingTypeId) : undefined,
    // Skipped entirely for a coach with no workoutPlans access at all.
    planQuantities: session.workoutPlanId && access.permissions.workoutPlans !== 'none'
      ? lookups.planEquipmentByPlanId.get(session.workoutPlanId)
      : undefined,
    equipmentById: lookups.equipmentById,
    rosterCount: roster.length,
  });

  return {
    classId,
    date: session.date,
    endDate: session.endDate ?? null,
    className: session.className ?? '',
    groupId: session.groupId ?? '',
    groupName: session.groupId ? (lookups.groupNameById.get(session.groupId) ?? '') : '',
    location: session.location ?? null,
    coachId: session.coachId ?? null,
    coachName: session.coachName ?? null,
    requiredEquipment,
    sessionOverride: sessionOverrideSummary(session),
    manualEquipment: session.manualEquipment ?? [],
    equipmentTaken: (session.equipmentTaken ?? []).map((t) => t.equipmentId),
    equipmentReturnedAt: session.equipmentReturnedAt ?? null,
    closedAt: session.closedAt ?? null,
    // Stripped for a coach with no workoutPlans access at all — hidden
    // rather than a 403 on the whole session.
    workoutPlanId: access.permissions.workoutPlans === 'none' ? null : (session.workoutPlanId ?? null),
    workoutPlanName: access.permissions.workoutPlans === 'none' ? null : (session.workoutPlanName ?? null),
    // Stripped the same way for a coach with no testsGrading access at all —
    // she has no reason to see a test-session flag she can't act on.
    isTestSession: access.permissions.testsGrading === 'none' ? false : (session.isTestSession === true),
    testGroupId: access.permissions.testsGrading === 'none' ? null : (session.testGroupId ?? null),
    testGroupName: access.permissions.testsGrading === 'none' ? null : (session.testGroupName ?? null),
    testComponentIds: access.permissions.testsGrading === 'none' ? null : (session.testComponentIds ?? null),
    isRunningSession: session.isRunningSession === true,
    traineeNote: session.traineeNote ?? null,
    traineeEquipment: session.traineeEquipment ?? [],
    recurringSessionId: session.recurringSessionId ?? null,
    roster,
  };
}
