import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { RegistrationItem } from '../lib/entities';

// GET or POST /getMemberBookingSources?memberId=xxx
// Auth: Cognito JWT. Defaults to caller's own; a different memberId requires
// admin — used by the admin roster/calendar views to color a member's
// classes by how each booking was paid for.
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  const memberId = event.queryStringParameters?.memberId || callerUid;
  if (memberId !== callerUid && !(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    FilterExpression: '#status = :registered',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pk': `MEMBER#${memberId}`, ':prefix': 'REG#', ':registered': 'REGISTERED' },
  }));

  const sources: Record<string, 'subscription' | 'punch_card'> = {};
  for (const item of (res.Items ?? []) as RegistrationItem[]) {
    if (!item.classId) continue;
    sources[item.classId] = item.consumedFrom === 'MEMBERSHIP' || item.consumedFrom === 'FUTURE_SUBSCRIPTION' ? 'subscription' : 'punch_card';
  }

  return json(200, { sources });
}
