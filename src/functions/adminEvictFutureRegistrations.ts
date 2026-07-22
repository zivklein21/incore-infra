import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import { queryMembershipForMonth } from '../lib/membershipQueries';
import { evictFutureRegistrations } from '../lib/paymentGrants';

// POST /adminEvictFutureRegistrations
// Auth: Cognito JWT, caller must be admin
// Body: { userId: string, targetMonth: string }
// Lets an admin manually trigger eviction without going through a payment
// failure — e.g. manually cancelling a subscription mid-cycle.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { userId?: unknown; targetMonth?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (err: any) {
    return json(400, { error: 'invalid_json' });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const targetMonth = typeof body.targetMonth === 'string' ? body.targetMonth.trim() : '';
  if (!userId || !targetMonth) return json(400, { error: 'missing_fields', required: ['userId', 'targetMonth'] });

  const memberRes = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `MEMBER#${userId}`, SK: 'PROFILE' } }));
  if (!memberRes.Item) return json(404, { error: 'member_not_found' });

  const membership = await queryMembershipForMonth(userId, targetMonth);
  if (membership) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: membership.PK, SK: membership.SK },
      UpdateExpression: 'SET #status = :pastDue, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pastDue': 'past_due', ':now': new Date().toISOString() },
    }));
  }

  await evictFutureRegistrations(userId, targetMonth);

  console.log(`[adminEvict] caller=${callerUid} evicted userId=${userId} month=${targetMonth}`);
  return json(200, { success: true });
}
