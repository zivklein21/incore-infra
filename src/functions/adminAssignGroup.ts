import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { resolveMemberProfile } from '../lib/memberLookup';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem, RegistrationItem } from '../lib/entities';

// POST /adminAssignGroup
// Body: { memberId: string, groupId: string | null } — null clears the assignment
// Auth: Cognito JWT, caller must be admin
// FORCA-only — rejects a memberId that resolves to the incore table, since
// Group assignment (identity.groupId) is meaningless for INCORE members.
//
// Safe group switch. Besides the live identity.groupId field — which is
// only what a *newly materialized* session auto-registers against (see
// sessionInstance.ts's createSessionInstance) — this also remaps her
// registration on every ClassItem that's already been materialized but
// hasn't happened yet: dropped from the old group's future sessions, added
// to the new group's, exactly as if she'd been in that group when each one
// was created. "Future" uses the same date >= now cutoff
// deleteFutureInstances()/adminSaveRecurringSession.ts already use — a
// session that has already occurred (attendance recorded, equipment logged,
// closed) is historical record and is never touched, matched or modified
// here. Financial state — ForcaBillingAgreementItem, ForcaSubscriptionOrderItem,
// PunchCardItem, wallet — has no relation to groupId at all, so none of it
// is read or written by this endpoint either; only ClassItem/RegistrationItem
// (future only) and the member's own identity.groupId are touched.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; groupId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) return json(400, { error: 'missing_member_id' });
  const newGroupId = typeof body.groupId === 'string' && body.groupId ? body.groupId : null;

  const resolved = await resolveMemberProfile(memberId);
  if (!resolved) return json(404, { error: 'member_not_found' });
  if (resolved.table !== FORCA_TABLE_NAME) return json(400, { error: 'not_a_forca_member' });

  const oldGroupId = resolved.profile.identity?.groupId ?? null;

  // identity is a DynamoDB reserved keyword — bare here it fails every call
  // (see adminUpdateMemberPersonal.ts's #identity alias for the same issue).
  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    UpdateExpression: newGroupId ? 'SET #identity.groupId = :groupId' : 'REMOVE #identity.groupId',
    ExpressionAttributeNames: { '#identity': 'identity' },
    ...(newGroupId ? { ExpressionAttributeValues: { ':groupId': newGroupId } } : {}),
  }));

  if (oldGroupId === newGroupId) {
    return json(200, { success: true, movedFromFutureSessions: 0, movedToFutureSessions: 0 });
  }

  const nowIso = new Date().toISOString();
  let movedFromFutureSessions = 0;
  let movedToFutureSessions = 0;

  // Drop her from the old group's not-yet-occurred sessions. GSI1 already
  // indexes every registration by member (see adminDeleteMember.ts's own use
  // of the same GSI1PK/prefix), so this reads only her registrations rather
  // than scanning every ClassItem in the old group.
  if (oldGroupId) {
    const regsRes = await ddb.send(new QueryCommand({
      TableName: FORCA_TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#' },
    }));
    const futureRegs = ((regsRes.Items ?? []) as RegistrationItem[]).filter((r) => r.classDate >= nowIso);

    await Promise.all(futureRegs.map(async (r) => {
      const classRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${r.classId}`, SK: 'METADATA' } }));
      const cls = classRes.Item as ClassItem | undefined;
      if (!cls || cls.groupId !== oldGroupId || !(cls.allowedMemberIds ?? []).includes(memberId)) return;

      await Promise.all([
        ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: r.PK, SK: r.SK } })),
        ddb.send(new UpdateCommand({
          TableName: FORCA_TABLE_NAME,
          Key: { PK: cls.PK, SK: 'METADATA' },
          UpdateExpression: 'SET allowedMemberIds = :ids ADD capacity :negOne, currentAttendeesCount :negOne',
          ExpressionAttributeValues: {
            ':ids': (cls.allowedMemberIds ?? []).filter((id) => id !== memberId),
            ':negOne': -1,
          },
        })),
      ]);
      movedFromFutureSessions += 1;
    }));
  }

  // Register her onto the new group's not-yet-occurred sessions — same
  // active-membership-window gate createSessionInstance() applies to a
  // brand-new session (a member with no active window is skipped, never
  // auto-registered). groupId isn't indexed, so this scans ClassItem the
  // same way adminSaveRecurringSession.ts's own future-instance patch does,
  // an accepted tradeoff at this table's documented ≤50-users-per-brand scale.
  if (newGroupId) {
    const start = typeof resolved.profile.membership?.start === 'string' ? new Date(resolved.profile.membership.start as string).getTime() : NaN;
    const end = typeof resolved.profile.membership?.end === 'string' ? new Date(resolved.profile.membership.end as string).getTime() : NaN;
    const hasActiveMembership = !Number.isNaN(start) && !Number.isNaN(end) && Date.now() >= start && Date.now() <= end;

    if (hasActiveMembership) {
      const futureClassesRes = await ddb.send(new ScanCommand({
        TableName: FORCA_TABLE_NAME,
        FilterExpression: 'groupId = :gid AND #dt >= :now',
        ExpressionAttributeNames: { '#dt': 'date' },
        ExpressionAttributeValues: { ':gid': newGroupId, ':now': nowIso },
      }));
      const futureClasses = (futureClassesRes.Items ?? []) as ClassItem[];

      await Promise.all(futureClasses.map(async (cls) => {
        if ((cls.allowedMemberIds ?? []).includes(memberId)) return;
        const classId = cls.PK.replace('CLASS#', '');

        await Promise.all([
          ddb.send(new PutCommand({
            TableName: FORCA_TABLE_NAME,
            Item: {
              PK: cls.PK, SK: `REG#${memberId}`,
              GSI1PK: `MEMBER#${memberId}`, GSI1SK: `REG##${classId}`,
              userId: memberId,
              classId,
              classDate: cls.date,
              status: 'REGISTERED',
              consumedFrom: 'FORCA_AUTO',
              membershipId: '',
              targetMonth: '',
              declaredAttendance: 'pending',
              actualAttendance: null,
              registeredAt: nowIso,
            },
          })),
          ddb.send(new UpdateCommand({
            TableName: FORCA_TABLE_NAME,
            Key: { PK: cls.PK, SK: 'METADATA' },
            UpdateExpression: 'SET allowedMemberIds = :ids ADD capacity :one, currentAttendeesCount :one',
            ExpressionAttributeValues: {
              ':ids': [...(cls.allowedMemberIds ?? []), memberId],
              ':one': 1,
            },
          })),
        ]);
        movedToFutureSessions += 1;
      }));
    }
  }

  return json(200, { success: true, movedFromFutureSessions, movedToFutureSessions });
}
