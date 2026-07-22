import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// GET or POST /adminGetMemberships?memberId=xxx
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const adminUid = getUid(event);
  if (!(await isAdmin(adminUid))) return json(403, { error: 'forbidden' });

  let bodyMemberId = '';
  if (event.body) {
    try {
      const body = JSON.parse(event.body) as { memberId?: unknown };
      bodyMemberId = typeof body.memberId === 'string' ? body.memberId : '';
    } catch {
      // ignore — fall through to query-param lookup
    }
  }
  const memberId = event.queryStringParameters?.memberId ?? bodyMemberId;
  if (!memberId) return json(400, { error: 'missing_member_id' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'MEMBERSHIP#' },
  }));

  const memberships = (res.Items ?? []).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  return json(200, { success: true, memberships });
}
