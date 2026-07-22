import { randomUUID } from 'crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { putPunchCardItem } from '../lib/punchCards';
import { monthKey } from '../lib/entities';

// POST /adminAddMemberCredit
// Auth: Cognito JWT, caller must be admin
// Body: { memberId: string, creditCount: number, sessionsPerCredit: number, expiresAt?: string (ISO) }
//
// Ad-hoc admin-issued credits — distinct from grantPunchCard.ts, which
// grants against a real Product (source: 'admin_grant'). Writes creditCount
// separate PunchCardItem entities (source: 'admin_credit'), matching the
// shape getWallet.ts's adminPunchCards already reads. No legacy array
// mirror — that's only relevant for product-sourced grants (StoreScreen
// reads it for purchase history), not admin ad-hoc credits.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let body: { memberId?: unknown; creditCount?: unknown; sessionsPerCredit?: unknown; expiresAt?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const creditCount = typeof body.creditCount === 'number' ? body.creditCount : NaN;
  const sessionsPerCredit = typeof body.sessionsPerCredit === 'number' ? body.sessionsPerCredit : NaN;
  const expiresAtRaw = typeof body.expiresAt === 'string' ? body.expiresAt : null;

  if (!memberId) return json(400, { error: 'missing_fields', required: ['memberId'] });
  if (!Number.isFinite(creditCount) || creditCount < 1) return json(400, { error: 'invalid_credit_count' });
  if (!Number.isFinite(sessionsPerCredit) || sessionsPerCredit < 1) return json(400, { error: 'invalid_sessions_per_credit' });

  let expiryDate: string | null = null;
  if (expiresAtRaw) {
    const parsed = new Date(expiresAtRaw);
    if (Number.isNaN(parsed.getTime())) return json(400, { error: 'invalid_expires_at' });
    expiryDate = parsed.toISOString();
  }

  const memberRes = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
  }));
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });

  // sourceMonth display (MemberDetailsScreen.tsx) special-cases values
  // starting with "admin" to render "Manual (2026-07)" instead of the raw
  // string — matching that existing convention rather than inventing a new one.
  const notes = `admin-${monthKey(new Date())}`;
  const cardIds: string[] = [];
  for (let i = 0; i < creditCount; i++) {
    const cardId = randomUUID();
    await putPunchCardItem({
      memberId,
      cardId,
      remainingPunches: sessionsPerCredit,
      expiryDate,
      notes,
      source: 'admin_credit',
    });
    cardIds.push(cardId);
  }

  console.log(`[adminAddMemberCredit] admin=${adminUid} member=${memberId} creditCount=${creditCount} sessionsPerCredit=${sessionsPerCredit} cards=${cardIds.join(',')}`);
  return json(200, { success: true, cardIds });
}
