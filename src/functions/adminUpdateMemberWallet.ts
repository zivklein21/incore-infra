import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { monthKey, type WalletItem } from '../lib/entities';
import { adjustCreditBuckets, walletKey } from '../lib/walletCredit';

// POST /adminUpdateMemberWallet
// Body: { memberId: string, extraPunches: number }
// Auth: Cognito JWT, caller must be admin
//
// Sets the WalletItem's extraPunches counter (PK=MEMBER#<uid>,
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

  // Existing batches keep their expiry — only the difference is applied
  // (see adjustCreditBuckets). Conditional on the balance read, so a booking
  // spending credit at the same moment isn't overwritten; retried on a race.
  let oldBalance = 0;
  for (let attempt = 0; ; attempt++) {
    const current = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: walletKey(memberId) }))).Item as WalletItem | undefined;
    oldBalance = current?.extraPunches ?? 0;
    const buckets = adjustCreditBuckets(current?.creditBuckets, oldBalance, extraPunches, monthKey(new Date()));
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: walletKey(memberId),
        UpdateExpression: 'SET extraPunches = :n, creditBuckets = :buckets, updatedAt = :now',
        ConditionExpression: current && typeof current.extraPunches === 'number' ? 'extraPunches = :old' : 'attribute_not_exists(extraPunches)',
        ExpressionAttributeValues: {
          ':n': extraPunches,
          ':buckets': buckets,
          ':now': new Date().toISOString(),
          ...(current && typeof current.extraPunches === 'number' ? { ':old': oldBalance } : {}),
        },
      }));
      break;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException && attempt < 2) continue;
      throw err;
    }
  }

  console.log(`[adminUpdateMemberWallet] admin=${adminUid} member=${memberId} extraPunches=${oldBalance}->${extraPunches}`);
  return json(200, { success: true });
}
