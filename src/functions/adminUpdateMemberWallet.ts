import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminUpdateMemberWallet
// Body: { memberId: string, extraPunches: number }
// Auth: Cognito JWT, caller must be admin
//
// Directly sets the WalletItem's extraPunches counter (PK=MEMBER#<uid>,
// SK=WALLET#PRIMARY, see getWallet.ts/bookClass.ts) — previously this value
// was only ever mutated by bookClass.ts's own ADD extraPunches :negOne on
// consumption, with no admin-facing way to edit or reset it. Overwrites the
// value directly, matching adminUpdateMemberCredit.ts's "set to this value"
// semantics rather than ADD-ing a delta. Uses SET (not a conditional
// create-if-missing check) so this also works for a member with no WalletItem
// yet.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; extraPunches?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const extraPunches = typeof body.extraPunches === 'number' ? body.extraPunches : NaN;

  if (!memberId) return json(400, { error: 'missing_fields', required: ['memberId'] });
  if (!Number.isFinite(extraPunches) || extraPunches < 0) return json(400, { error: 'invalid_extra_punches' });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'WALLET#PRIMARY' },
    UpdateExpression: 'SET extraPunches = :n, updatedAt = :now',
    ExpressionAttributeValues: { ':n': extraPunches, ':now': new Date().toISOString() },
  }));

  console.log(`[adminUpdateMemberWallet] admin=${adminUid} member=${memberId} extraPunches=${extraPunches}`);
  return json(200, { success: true });
}
