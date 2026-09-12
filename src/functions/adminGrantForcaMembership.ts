import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { MemberProfileItem } from '../lib/entities';

// POST /adminGrantForcaMembership
// Body: { memberId: string, title: string, startDate: string, endDate: string }
// Auth: Cognito JWT, caller must be admin
//
// FORCA's equivalent of INCORE's admin-manual CUSTOM_MIGRATION bridge
// membership (see adminGrantCustomMigration.ts) — but far simpler, since
// FORCA has no monthly-cycle billing to bridge, no weekly/session limits,
// and no separate MembershipItem collection (see entities.ts's GroupItem
// doc comment: FORCA never had a membership-plan concept at all). This just
// writes start/end/title straight onto the member's own PROFILE item as
// `membership` — the exact same field getProfile.ts / getChildProfile.ts /
// getMemberDetail.ts already read into `membershipStart`/`membershipEnd`
// for the Overview tab's "Activity Validity" line, so surfacing it there
// needed zero changes on the read side. createSessionInstance.ts (in
// sessionInstance.ts) is the actual gate: a member with no active window
// here is silently skipped when a new session auto-registers her group,
// same "new registrations only" scope INCORE's own bookClass.ts gate has —
// this never touches sessions she's already registered for.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; title?: unknown; startDate?: unknown; endDate?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const startDate = typeof body.startDate === 'string' ? body.startDate : '';
  const endDate = typeof body.endDate === 'string' ? body.endDate : '';
  if (!memberId || !title || !startDate || !endDate) return json(400, { error: 'missing_fields' });
  if (new Date(startDate).getTime() >= new Date(endDate).getTime()) return json(400, { error: 'invalid_date_range' });

  const key = { PK: `MEMBER#${memberId}`, SK: 'PROFILE' };
  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: key }));
  const profile = res.Item as MemberProfileItem | undefined;
  if (!profile) return json(404, { error: 'member_not_found' });

  const membership = {
    title,
    start: startDate,
    end: endDate,
    grantedBy: callerUid,
    grantedAt: new Date().toISOString(),
  };

  await ddb.send(new UpdateCommand({
    TableName: FORCA_TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET membership = :membership',
    ExpressionAttributeValues: { ':membership': membership },
  }));

  return json(200, { success: true, membership });
}
