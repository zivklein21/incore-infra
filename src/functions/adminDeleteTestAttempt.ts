import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { getCoachAccess, groupInAccess } from '../lib/coachAccess';
import { resolveMemberProfile } from '../lib/memberLookup';
import type { TestAttemptItem } from '../lib/entities';

// POST /adminDeleteTestAttempt
// Body: { id: string }
// Auth: Cognito JWT, admin or a coach with testsGrading:'write' — same
// access level as recording one (adminRecordTestAttempt.ts); a coach may
// only delete an attempt belonging to a trainee in one of her assigned
// groups.
// Hard delete — the displayed instance rank and changeVsPrevious for the
// remaining attempts are recomputed fresh on the next adminGetTestAttempts.ts
// read (testAttemptOrdering.ts), so no renumbering happens here.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const access = await getCoachAccess(callerUid);
  if (!access || access.permissions.testsGrading !== 'write') return json(403, { error: 'forbidden' });

  let body: { id?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });

  const res = await ddb.send(new GetCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTATTEMPT#${id}`, SK: 'METADATA' } }));
  const attempt = res.Item as TestAttemptItem | undefined;
  if (!attempt) return json(404, { error: 'test_attempt_not_found' });

  if (!access.isAdmin) {
    const target = await resolveMemberProfile(attempt.userId);
    if (!target || !groupInAccess(access, target.profile.identity?.groupId)) return json(403, { error: 'forbidden' });
  }

  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTATTEMPT#${id}`, SK: 'METADATA' } }));

  return json(200, { success: true });
}
