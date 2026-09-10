import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isCoachOrAdmin } from '../lib/auth';
import {
  deriveMemberName,
  type ClassItem,
  type EquipmentItem,
  type GroupItem,
  type MemberProfileItem,
  type RegistrationItem,
  type TrainingTypeItem,
} from '../lib/entities';

// GET or POST /getCoachSessions
// Auth: Cognito JWT, caller must be a coach or admin (isCoachOrAdmin)
//
// Lists every FORCA training session (a ClassItem with a groupId — see
// createTrainingSession.ts) with its full roster: declared + actual
// attendance per auto-registered member, plus (when the session has a
// trainingTypeId) the equipment pack list — each requirement resolved to
// {id, name, neededQuantity, availableQuantity}: a 'custom' requirement's
// neededQuantity is just its fixed customQuantity; a 'per_member' one is
// this session's exact roster size (createTrainingSession.ts auto-registers
// every current Group member, so that count is known precisely per session).
// availableQuantity (EquipmentItem.quantity - outCount) is what lets the
// coach's checklist flag "missing" right where she's actually collecting
// gear for THIS session — not at Training Type definition time, when no
// concrete session/roster exists yet to check against. Also carries
// groupName, location, coachName, what's currently checked out
// (equipmentTaken, as ids), and when it was last logged fully returned
// (equipmentReturnedAt). Each roster entry additionally carries
// declineReason (set when she declared 'no' — see declareAttendance.ts)
// and medicalFlag (any 'yes' answer on her health declaration, independent
// of doctor-approval status — same raw signal AdminHealthDeclarationsScreen.tsx's
// getHealthStatus reads, just not collapsed once a doctor's note exists).
// This is also what the FORCA admin Home dashboard reuses (via
// useCoachSessions(), filtered/sorted client-side) — no separate endpoint.
// View-only except for markActualAttendance.ts / toggleSessionEquipment.ts /
// returnSessionEquipment.ts.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isCoachOrAdmin(callerUid))) return json(403, { error: 'forbidden' });

  // Table documented for <=50 users per brand (dynamodb.tf) — same accepted
  // Scan tradeoff as getClasses.ts.
  const [sessionsRes, trainingTypesRes, groupsRes] = await Promise.all([
    ddb.send(new ScanCommand({
      TableName: FORCA_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :metadata AND attribute_exists(groupId)',
      ExpressionAttributeValues: { ':prefix': 'CLASS#', ':metadata': 'METADATA' },
    })),
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
  const sessionItems = (sessionsRes.Items ?? []) as (ClassItem & { PK: string; groupId?: string })[];
  const trainingTypesById = new Map(
    ((trainingTypesRes.Items ?? []) as TrainingTypeItem[]).map((t) => [t.PK.replace('TRAININGTYPE#', ''), t]),
  );
  const groupNameById = new Map(
    ((groupsRes.Items ?? []) as GroupItem[]).map((g) => [g.PK.replace('GROUP#', ''), g.name ?? '']),
  );

  // Only fetched when at least one session actually references equipment —
  // most sessions have no trainingTypeId at all.
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

  const sessions = await Promise.all(sessionItems.map(async (session) => {
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

    const roster = registrations.map((r, i) => {
      const profile = profiles[i].Item as MemberProfileItem | undefined;
      const healthAnswers = profile?.forms?.health_declaration?.answers ?? {};
      return {
        memberId: r.userId,
        name: profile ? deriveMemberName(profile) : r.userId,
        declaredAttendance: r.declaredAttendance ?? 'pending',
        declineReason: r.declineReason || null,
        actualAttendance: r.actualAttendance ?? null,
        medicalFlag: Object.values(healthAnswers).some((v) => v === 'yes'),
      };
    });
    roster.sort((a, b) => a.name.localeCompare(b.name));

    const trainingType = session.trainingTypeId ? trainingTypesById.get(session.trainingTypeId) : undefined;
    const requiredEquipment = (trainingType?.equipmentRequirements ?? []).map((r) => {
      const equipment = equipmentById.get(r.equipmentId);
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
      groupName: session.groupId ? (groupNameById.get(session.groupId) ?? '') : '',
      location: session.location ?? null,
      coachId: session.coachId ?? null,
      coachName: session.coachName ?? null,
      requiredEquipment,
      equipmentTaken: (session.equipmentTaken ?? []).map((t) => t.equipmentId),
      equipmentReturnedAt: session.equipmentReturnedAt ?? null,
      roster,
    };
  }));

  sessions.sort((a, b) => b.date.localeCompare(a.date));

  return json(200, { sessions });
}
