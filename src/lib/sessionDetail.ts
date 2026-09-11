// Shared "resolve a training session's full detail (roster + equipment pack
// list)" logic — extracted out of getCoachSessions.ts so getTrainingHistory.ts
// can reuse the exact same computation instead of duplicating it. See
// getCoachSessions.ts for the full behavioral write-up.

import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from './dynamo';
import type { CoachAccess } from './coachAccess';
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
}

/**
 * Fetches the shared Training Type / Group / Equipment lookup tables needed
 * to resolve any set of sessions — equipment is only scanned when at least
 * one of the given sessions actually references a training type with
 * equipment requirements, since most callers' session sets are untyped.
 */
export async function fetchSessionLookups(sessionItems: ClassItem[]): Promise<SessionLookups> {
  const [trainingTypesRes, groupsRes] = await Promise.all([
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
  ]);
  const trainingTypesById = new Map(
    ((trainingTypesRes.Items ?? []) as TrainingTypeItem[]).map((t) => [t.PK.replace('TRAININGTYPE#', ''), t]),
  );
  const groupNameById = new Map(
    ((groupsRes.Items ?? []) as GroupItem[]).map((g) => [g.PK.replace('GROUP#', ''), g.name ?? '']),
  );

  const equipmentIdsNeeded = new Set<string>();
  for (const session of sessionItems) {
    const tt = session.trainingTypeId ? trainingTypesById.get(session.trainingTypeId) : undefined;
    (tt?.equipmentRequirements ?? []).forEach((r) => equipmentIdsNeeded.add(r.equipmentId));
  }
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

  return { trainingTypesById, groupNameById, equipmentById };
}

export interface RosterEntryDetail {
  memberId: string;
  name: string;
  declaredAttendance: 'pending' | 'yes' | 'no';
  declineReason: string | null;
  actualAttendance: 'present' | 'absent' | null;
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

  const profiles = await Promise.all(registrations.map((r) =>
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${r.userId}`, SK: 'PROFILE' } })),
  ));

  const roster: RosterEntryDetail[] = registrations.map((r, i) => {
    const profile = profiles[i].Item as MemberProfileItem | undefined;
    const healthAnswers = profile?.forms?.health_declaration?.answers ?? {};
    return {
      memberId: r.userId,
      name: profile ? deriveMemberName(profile) : r.userId,
      declaredAttendance: r.declaredAttendance ?? 'pending',
      declineReason: r.declineReason || null,
      actualAttendance: r.actualAttendance ?? null,
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
    roster,
  };
}
