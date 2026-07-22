import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminDeleteMemberCredit
// Body: { memberId: string, creditId: string }
// Auth: Cognito JWT, caller must be admin
//
// Deletes a single PunchCardItem (PK=MEMBER#<uid>, SK=PUNCHCARD#<cardId>) —
// the same entity both admin-issued ad-hoc credits (adminAddMemberCredit.ts,
// source: 'admin_credit') and product-based grants (grantPunchCard.ts,
// source: 'admin_grant') write, matching what the admin Credits UI lists
// regardless of source.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; creditId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const creditId = typeof body.creditId === 'string' ? body.creditId.trim() : '';
  if (!memberId || !creditId) return json(400, { error: 'missing_fields', required: ['memberId', 'creditId'] });

  await ddb.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: `PUNCHCARD#${creditId}` },
  }));

  console.log(`[adminDeleteMemberCredit] admin=${adminUid} member=${memberId} credit=${creditId}`);
  return json(200, { success: true });
}
