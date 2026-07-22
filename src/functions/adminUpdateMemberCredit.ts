import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminUpdateMemberCredit
// Body: { memberId: string, creditId: string, sessions: number, expiresAt?: string (ISO) }
// Auth: Cognito JWT, caller must be admin
//
// Edits an existing PunchCardItem (PK=MEMBER#<uid>, SK=PUNCHCARD#<cardId>) —
// same entity adminAddMemberCredit.ts creates and adminDeleteMemberCredit.ts
// removes. Overwrites remainingPunches/expiryDate directly rather than
// ADD-ing a delta, matching the "set to this value" semantics of the edit
// form (sessions/expiry inputs pre-filled with the current values).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; creditId?: unknown; sessions?: unknown; expiresAt?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const creditId = typeof body.creditId === 'string' ? body.creditId.trim() : '';
  const sessions = typeof body.sessions === 'number' ? body.sessions : NaN;
  const expiresAtRaw = typeof body.expiresAt === 'string' ? body.expiresAt : null;

  if (!memberId || !creditId) return json(400, { error: 'missing_fields', required: ['memberId', 'creditId'] });
  if (!Number.isFinite(sessions) || sessions < 0) return json(400, { error: 'invalid_sessions' });

  let expiryDate: string | null = null;
  if (expiresAtRaw) {
    const parsed = new Date(expiresAtRaw);
    if (Number.isNaN(parsed.getTime())) return json(400, { error: 'invalid_expires_at' });
    expiryDate = parsed.toISOString();
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: `PUNCHCARD#${creditId}` },
    ConditionExpression: 'attribute_exists(PK)',
    UpdateExpression: 'SET remainingPunches = :sessions, expiryDate = :expiryDate',
    ExpressionAttributeValues: { ':sessions': sessions, ':expiryDate': expiryDate },
  }));

  console.log(`[adminUpdateMemberCredit] admin=${adminUid} member=${memberId} credit=${creditId} sessions=${sessions}`);
  return json(200, { success: true });
}
