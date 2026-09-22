import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { resolveMemberProfile } from '../lib/memberLookup';
import { notifyAdmins } from '../lib/adminNotify';
import { getExpoPushToken, sendExpoPush } from '../lib/push';
import { deriveMemberName } from '../lib/entities';
import type { ClassItem, MemberProfileItem, RegistrationItem } from '../lib/entities';

// POST /declareAttendance
// Body: { classId: string, declaredAttendance: 'yes' | 'no', declineReason?: string }
// Auth: Cognito JWT, any signed-in member — but only for her own registration
// (the REG#<callerUid> item under CLASS#<classId> must exist; there's no
// admin/coach override here, that's markActualAttendance.ts's job instead).
// FORCA-only. declineReason is only stored when declaredAttendance is 'no'.
//
// A 'yes' declaration is blocked (server-side, not just the Trainee
// Dashboard's own UI gate) when her Medical Profile has an outstanding
// clearance request she hasn't uploaded for yet, or when she's self-flagged
// a medical condition change still pending admin/coach review — see
// reportMedicalConditionChange.ts / adminClearMedicalCondition.ts. 'no'
// declarations are never blocked — declining never needs medical sign-off.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);

  let body: { classId?: unknown; declaredAttendance?: unknown; declineReason?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  if (!classId) return json(400, { error: 'missing_class_id' });
  const declaredAttendance = body.declaredAttendance === 'yes' || body.declaredAttendance === 'no' ? body.declaredAttendance : null;
  if (!declaredAttendance) return json(400, { error: 'invalid_declared_attendance' });
  const declineReason = declaredAttendance === 'no' && typeof body.declineReason === 'string' ? body.declineReason.trim() : '';

  if (declaredAttendance === 'yes') {
    const resolved = await resolveMemberProfile(callerUid);
    const forms = resolved?.profile.forms ?? {};
    if (forms.medical_clearance_requested === true && !forms.medical_clearance_uploaded_at) {
      return json(403, { error: 'medical_clearance_required' });
    }
    if (forms.medical_condition_changed === true) {
      return json(403, { error: 'medical_condition_pending_review' });
    }
  }

  const key = { PK: `CLASS#${classId}`, SK: `REG#${callerUid}` };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const registration = res.Item as RegistrationItem | undefined;
  if (!registration) return json(404, { error: 'registration_not_found' });

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET declaredAttendance = :declaredAttendance, declineReason = :declineReason',
    ExpressionAttributeValues: { ':declaredAttendance': declaredAttendance, ':declineReason': declineReason },
  }));

  // Alerts admins (push + their notification inbox — notifyAdmins() reads
  // TABLE_NAME/incore, which is correct here even though this endpoint is
  // FORCA-only: admins aren't brand-scoped, see isAdmin()'s doc comment)
  // and, separately, pushes directly to the session's assigned coach (no
  // ROLE#coach fan-out exists, and a broadcast to every coach would be
  // wrong anyway — only the coach actually running this session needs to
  // know). Awaited (not truly fire-and-forget) so Lambda doesn't freeze the
  // execution environment mid-send right after this returns; failures are
  // caught and logged, never allowed to fail the trainee's own declare
  // action, which has already succeeded above.
  if (declaredAttendance === 'no') {
    await notifyDecline(callerUid, classId, declineReason).catch((err) => {
      console.error('[declareAttendance] decline notify failed', err);
    });
  }

  return json(200, { success: true });
}

async function notifyDecline(callerUid: string, classId: string, declineReason: string): Promise<void> {
  const [classRes, callerResolved] = await Promise.all([
    ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `CLASS#${classId}`, SK: 'METADATA' } })),
    resolveMemberProfile(callerUid),
  ]);
  const session = classRes.Item as ClassItem | undefined;
  if (!session || !callerResolved) return;

  const traineeName = deriveMemberName(callerResolved.profile);
  const dateStr = new Date(session.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
  const message = `${traineeName} won't attend ${session.className ?? 'training'} on ${dateStr}.`
    + (declineReason ? ` Reason: ${declineReason}` : '');

  await notifyAdmins({
    type: 'FORCA_ATTENDANCE_DECLINED',
    priority: 'NORMAL',
    pushTitle: 'Trainee declined attendance',
    message,
    extra: { memberId: callerUid, classId },
    pushData: { screen: 'ForcaAdminHome', classId },
  });

  if (session.coachId) {
    const coachRes = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `MEMBER#${session.coachId}`, SK: 'PROFILE' } }));
    const coachProfile = coachRes.Item as MemberProfileItem | undefined;
    const token = coachProfile ? getExpoPushToken(coachProfile) : null;
    if (token) await sendExpoPush(token, 'Trainee declined attendance', message, { screen: 'CoachSessions', classId });
  }
}
