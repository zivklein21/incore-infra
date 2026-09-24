// Shared "resolve a training session's full detail (roster + equipment pack
// list)" logic — extracted out of getCoachSessions.ts so getTrainingHistory.ts
// can reuse the exact same computation instead of duplicating it. See
// getCoachSessions.ts for the full behavioral write-up.

import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { CoachAccess } from './coachAccess';
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

export interface SessionLookups {
  trainingTypesById: Map<string, TrainingTypeItem>;
  groupNameById: Map<string, string>;
  equipmentById: Map<string, { name: string; availableQuantity: number }>;
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
  const equipmentById = new Map<string, { name: string; availableQuantity: number }>();
  if (equipmentIdsNeeded.size > 0) {
    const equipmentRes = await ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata',
      ExpressionAttributeValues: { ':prefix': 'EQUIPMENT#', ':metadata': 'METADATA' },
    }));
    for (const e of (equipmentRes.Items ?? []) as EquipmentItem[]) {
      equipmentById.set(e.PK.replace('EQUIPMENT#', ''), {
        name: e.name ?? '',
        availableQuantity: (e.quantity ?? 0) - (e.outCount ?? 0),
      });
    }
  }

  return { trainingTypesById, groupNameById, equipmentById, planEquipmentByPlanId, profileById };
}

export interface RosterEntryDetail {
  memberId: string;
  name: string;
  declaredAttendance: 'pending' | 'yes' | 'no';
  declineReason: string | null;
  actualAttendance: 'present' | 'absent' | null;
  /** Who last recorded/corrected actualAttendance — see RegistrationItem.actualAttendanceBy. Null on any entry predating this field, or with no actualAttendance recorded yet. */
  actualAttendanceBy: { uid: string; name: string; role: 'admin' | 'coach' } | null;
  medicalFlag: boolean;
}

export interface SessionDetail {
  classId: string;
  date: string;
  className: string;
  groupId: string;
  groupName: string;
  location: string | null;
  coachId: string | null;
  coachName: string | null;
  requiredEquipment: { id: string; name: string; neededQuantity: number; availableQuantity: number }[];
  equipmentTaken: string[];
  equipmentReturnedAt: string | null;
  closedAt: string | null;
  workoutPlanId: string | null;
  workoutPlanName: string | null;
  isTestSession: boolean;
  testGroupId: string | null;
  testGroupName: string | null;
  testComponentIds: string[] | null;
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
      medicalFlag: access.permissions.healthDeclarations === 'none'
        ? false
        : Object.values(healthAnswers).some((v) => v === 'yes'),
    };
  });
  roster.sort((a, b) => a.name.localeCompare(b.name));

  const trainingType = session.trainingTypeId ? lookups.trainingTypesById.get(session.trainingTypeId) : undefined;
  const requiredEquipment = (trainingType?.equipmentRequirements ?? []).map((r) => {
    const equipment = lookups.equipmentById.get(r.equipmentId);
    return {
      id: r.equipmentId,
      name: equipment?.name ?? '',
      neededQuantity: r.mode === 'custom' ? (r.customQuantity ?? 0) : roster.length,
      availableQuantity: equipment?.availableQuantity ?? 0,
    };
  });

  // The assigned Workout Plan's own required equipment, on top of whatever
  // the Training Type already lists — same checkout-tracked pack list, not
  // a separate one (see toggleSessionEquipment.ts). Quantity is the sum of
  // each exercise's own ExerciseEquipmentRequirement across the plan's
  // stations (see resolveWorkoutPlanEquipmentQuantities()) — there's no
  // custom/per_member "mode" for a plan-derived item the way a Training
  // Type requirement has, so this is the closest real equivalent. Skipped
  // entirely for a coach with no workoutPlans access at all, and never
  // duplicated for an equipmentId the Training Type already covers.
  if (session.workoutPlanId && access.permissions.workoutPlans !== 'none') {
    const existingIds = new Set(requiredEquipment.map((e) => e.id));
    for (const [equipmentId, neededQuantity] of lookups.planEquipmentByPlanId.get(session.workoutPlanId) ?? []) {
      if (existingIds.has(equipmentId)) continue;
      const equipment = lookups.equipmentById.get(equipmentId);
      requiredEquipment.push({
        id: equipmentId,
        name: equipment?.name ?? '',
        neededQuantity,
        availableQuantity: equipment?.availableQuantity ?? 0,
      });
    }
  }

  return {
    classId,
    date: session.date,
    className: session.className ?? '',
    groupId: session.groupId ?? '',
    groupName: session.groupId ? (lookups.groupNameById.get(session.groupId) ?? '') : '',
    location: session.location ?? null,
    coachId: session.coachId ?? null,
    coachName: session.coachName ?? null,
    requiredEquipment,
    equipmentTaken: (session.equipmentTaken ?? []).map((t) => t.equipmentId),
    equipmentReturnedAt: session.equipmentReturnedAt ?? null,
    closedAt: session.closedAt ?? null,
    // Stripped for a coach with no workoutPlans access at all, same
    // "hide rather than 403 the whole session" convention medicalFlag above
    // uses for healthDeclarations:'none'.
    workoutPlanId: access.permissions.workoutPlans === 'none' ? null : (session.workoutPlanId ?? null),
    workoutPlanName: access.permissions.workoutPlans === 'none' ? null : (session.workoutPlanName ?? null),
    // Stripped the same way for a coach with no testsGrading access at all —
    // she has no reason to see a test-session flag she can't act on.
    isTestSession: access.permissions.testsGrading === 'none' ? false : (session.isTestSession === true),
    testGroupId: access.permissions.testsGrading === 'none' ? null : (session.testGroupId ?? null),
    testGroupName: access.permissions.testsGrading === 'none' ? null : (session.testGroupName ?? null),
    testComponentIds: access.permissions.testsGrading === 'none' ? null : (session.testComponentIds ?? null),
    roster,
  };
}
