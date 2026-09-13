import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../lib/dynamo';
import { getUid, json } from '../lib/http';
import { isAdmin } from '../lib/auth';

// POST /adminDeleteTestComponent
// Body: { id: string, groupId: string } — groupId is required because
// PK=TESTGROUP#<groupId>/SK=COMPONENT#<id> is a composite key (see
// entities.ts); deleting the group itself is adminDeleteTestGroup.ts.
// Auth: Cognito JWT, caller must be admin
// Hard delete — past TestAttemptItems are untouched (historical record;
// denormalized componentName/metricType keep them meaningful).
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyStructuredResultV2> {
  const callerUid = getUid(event);
  if (!(await isAdmin(callerUid))) return json(403, { error: 'forbidden' });

  let body: { id?: unknown; groupId?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json(400, { error: 'missing_id' });
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
  if (!groupId) return json(400, { error: 'missing_group_id' });

  await ddb.send(new DeleteCommand({ TableName: FORCA_TABLE_NAME, Key: { PK: `TESTGROUP#${groupId}`, SK: `COMPONENT#${id}` } }));

  return json(200, { success: true });
}
