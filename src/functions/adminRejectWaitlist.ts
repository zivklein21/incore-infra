import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';
import type { ClassItem } from '../lib/entities';

// POST /adminRejectWaitlist
// Body: { classId, userId }
// Auth: Cognito JWT, caller must be admin
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { classId?: unknown; userId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const classId = typeof body.classId === 'string' ? body.classId.trim() : '';
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!classId || !userId) return json(400, { error: 'missing_fields', required: ['classId', 'userId'] });

  const key = { PK: `CLASS#${classId}`, SK: 'METADATA' };
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  const item = res.Item as ClassItem | undefined;
  if (!item) return json(404, { error: 'class_not_found' });

  const waitlist = (item.waitlist ?? []).filter((e) => e.member !== userId);

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: key,
    UpdateExpression: 'SET waitlist = :waitlist',
    ExpressionAttributeValues: { ':waitlist': waitlist },
  }));

  return json(200, { success: true });
}
